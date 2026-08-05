import path from 'node:path'

import { describe, expect, it, vi, beforeEach } from 'vitest'

import {
    applyExcludes,
    emitEvents,
    findUnlaunchedSpecs,
    hasPerCapabilitySpecFilters,
    reportUnlaunchedSpecs,
    resolveSpecPatterns
} from '../../src/testOps/unlaunchedSpecReporter.js'
import * as specEnumerator from '../../src/testOps/specEnumerator.js'
import { BrowserstackCLI } from '../../src/cli/index.js'
import { GrpcClient } from '../../src/cli/grpcClient.js'
import * as util from '../../src/util.js'
import type { UploadType } from '../../src/types.js'

describe('findUnlaunchedSpecs', () => {
    it('returns specs that never reached a worker', () => {
        const all = ['/p/a.spec.js', '/p/b.spec.js', '/p/c.spec.js']
        expect(findUnlaunchedSpecs(all, new Set(['/p/a.spec.js'])))
            .toEqual(['/p/b.spec.js', '/p/c.spec.js'])
    })

    it('matches regardless of file:// prefix or relative form', () => {
        const all = ['/p/a.spec.js', '/p/b.spec.js']
        // workers report specs as file:// URLs; the config list does not
        expect(findUnlaunchedSpecs(all, new Set(['file:///p/a.spec.js'])))
            .toEqual(['/p/b.spec.js'])
    })

    it('returns nothing when every spec ran', () => {
        const all = ['/p/a.spec.js']
        expect(findUnlaunchedSpecs(all, new Set(['/p/a.spec.js']))).toEqual([])
    })

    it('returns everything when no worker ever started', () => {
        const all = ['/p/a.spec.js', '/p/b.spec.js']
        expect(findUnlaunchedSpecs(all, new Set())).toEqual(all)
    })
})

describe('resolveSpecPatterns', () => {
    const fixtures = path.join(process.cwd(), 'tests', 'testOps')

    it('resolves a concrete relative path even when it matches no glob', async () => {
        const resolved = await resolveSpecPatterns(['unlaunchedSpecReporter.test.ts'], fixtures)
        expect(resolved).toEqual([path.join(fixtures, 'unlaunchedSpecReporter.test.ts')])
    })

    it('expands glob patterns to absolute paths', async () => {
        const resolved = await resolveSpecPatterns(['*.test.ts'], fixtures)
        expect(resolved.length).toBeGreaterThan(0)
        expect(resolved.every(p => path.isAbsolute(p))).toBe(true)
        expect(resolved).toContain(path.join(fixtures, 'unlaunchedSpecReporter.test.ts'))
    })

    it('flattens nested arrays (wdio spec grouping) and de-dupes', async () => {
        const resolved = await resolveSpecPatterns(
            [['unlaunchedSpecReporter.test.ts'], 'unlaunchedSpecReporter.test.ts'],
            fixtures
        )
        expect(resolved).toHaveLength(1)
    })

    it('strips the file:// prefix', async () => {
        const resolved = await resolveSpecPatterns(['file:///p/a.spec.js'], fixtures)
        expect(resolved).toEqual(['/p/a.spec.js'])
    })

    it('ignores non-string entries instead of throwing', async () => {
        await expect(resolveSpecPatterns([null, 42, undefined], fixtures)).resolves.toEqual([])
    })
})

describe('applyExcludes', () => {
    const root = '/proj'
    const specs = ['/proj/tests/a.spec.js', '/proj/tests/flaky-b.spec.js', '/proj/tests/c.spec.js']

    it('matches exactly when every entry looks like a path', () => {
        expect(applyExcludes(specs, ['tests/flaky-b.spec.js'], root))
            .toEqual(['/proj/tests/a.spec.js', '/proj/tests/c.spec.js'])
    })

    it('matches by substring when entries are bare keywords — wdio filterSpecs semantics', () => {
        // `exclude: ['flaky']` must drop any spec whose path contains it; resolving it as a
        // literal path would match nothing and the spec would be reported as skipped
        expect(applyExcludes(specs, ['flaky'], root))
            .toEqual(['/proj/tests/a.spec.js', '/proj/tests/c.spec.js'])
    })

    it('handles glob entries as path-like', () => {
        expect(applyExcludes(specs, ['/proj/tests/*.spec.js'], root)).toEqual(specs)
    })

    it('returns specs untouched for an empty or missing exclude list', () => {
        expect(applyExcludes(specs, [], root)).toEqual(specs)
        expect(applyExcludes(specs, undefined as unknown as string[], root)).toEqual(specs)
    })
})

describe('hasPerCapabilitySpecFilters', () => {
    // when a capability narrows the spec set, the top-level config no longer describes what
    // the run intended to execute — reporting from it would mark excluded specs as skipped
    it('is false for plain capabilities', () => {
        expect(hasPerCapabilitySpecFilters([{ browserName: 'chrome' }])).toBe(false)
    })

    it('detects wdio:specs and wdio:exclude', () => {
        expect(hasPerCapabilitySpecFilters([{ browserName: 'chrome', 'wdio:specs': ['a.js'] }])).toBe(true)
        expect(hasPerCapabilitySpecFilters([{ browserName: 'chrome', 'wdio:exclude': ['b.js'] }])).toBe(true)
    })

    it('detects the deprecated specs/exclude spelling', () => {
        expect(hasPerCapabilitySpecFilters([{ exclude: ['b.js'] }])).toBe(true)
    })

    it('detects filters nested under multiremote capabilities', () => {
        expect(hasPerCapabilitySpecFilters({
            browserA: { capabilities: { browserName: 'chrome', 'wdio:exclude': ['b.js'] } }
        })).toBe(true)
    })

    it('is false for multiremote without filters, and for empty input', () => {
        expect(hasPerCapabilitySpecFilters({
            browserA: { capabilities: { browserName: 'chrome' } }
        })).toBe(false)
        expect(hasPerCapabilitySpecFilters([])).toBe(false)
        expect(hasPerCapabilitySpecFilters(undefined)).toBe(false)
    })
})

describe('reported identity matches getUniqueIdentifier', () => {
    // A test reported skipped here and the same test on a later successful run must carry one
    // identity, or TM sees two tests and rerun reconciliation breaks. getUniqueIdentifier
    // (util.ts) builds `${parent} - ${title}`; mocha's own fullTitle is space-joined and would
    // not match. This pins the format.
    it('builds `parent - title`, not mocha fullTitle', async () => {
        const enqueueTestEvent = vi.fn().mockResolvedValue({ success: true })
        vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({ isRunning: () => true } as any)
        vi.spyOn(GrpcClient, 'getInstance').mockReturnValue({ enqueueTestEvent } as any)
        vi.spyOn(specEnumerator, 'enumerateSpecs').mockResolvedValue([
            {
                fullTitle: 'Suite B SB-TC1',
                title: 'SB-TC1',
                scopes: ['Suite B'],
                file: '/proj/tests/b.spec.js'
            }
        ])

        await reportUnlaunchedSpecs(['/proj/tests/b.spec.js'], new Set(), '/proj')

        const sent = enqueueTestEvent.mock.calls.map(c => c[1] as { test_run: Record<string, unknown> })
        expect(sent).toHaveLength(2) // TestRunStarted + TestRunFinished
        for (const event of sent) {
            expect(event.test_run.identifier).toBe('Suite B - SB-TC1')
            expect(event.test_run.scope).toBe('Suite B - SB-TC1')
            expect(event.test_run.name).toBe('SB-TC1')
            expect(event.test_run.scopes).toEqual(['Suite B'])
            expect(event.test_run.result).toBe('skipped')
        }
    })
})

describe('emitEvents transport routing', () => {
    const events: UploadType[] = [
        { event_type: 'TestRunStarted', test_run: { uuid: 'u1' } },
        { event_type: 'TestRunFinished', test_run: { uuid: 'u1' } }
    ]

    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('relays one gRPC call per event when the binary is running', async () => {
        // the launcher's TESTHUB_JWT has no build claim on this path, so the collector would
        // 401 — events must go through the binary, which holds the build-scoped credential
        const enqueueTestEvent = vi.fn().mockResolvedValue({ success: true })
        vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({ isRunning: () => true } as any)
        vi.spyOn(GrpcClient, 'getInstance').mockReturnValue({ enqueueTestEvent } as any)
        const batchSpy = vi.spyOn(util, 'batchAndPostEvents').mockResolvedValue(undefined as any)

        await emitEvents(events)

        // one call per event — the binary's handler takes a single event, not a batch
        expect(enqueueTestEvent).toHaveBeenCalledTimes(2)
        expect(enqueueTestEvent.mock.calls[0][1]).toEqual(events[0])
        expect(batchSpy).not.toHaveBeenCalled()
    })

    it('falls back to the HTTP batch when no binary is running', async () => {
        vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({ isRunning: () => false } as any)
        const enqueueTestEvent = vi.fn()
        vi.spyOn(GrpcClient, 'getInstance').mockReturnValue({ enqueueTestEvent } as any)
        const batchSpy = vi.spyOn(util, 'batchAndPostEvents').mockResolvedValue(undefined as any)

        await emitEvents(events)

        expect(batchSpy).toHaveBeenCalledTimes(1)
        expect(batchSpy.mock.calls[0][2]).toEqual(events)
        expect(enqueueTestEvent).not.toHaveBeenCalled()
    })
})
