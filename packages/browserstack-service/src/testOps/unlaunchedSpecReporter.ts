import path from 'node:path'

import { v4 as uuidv4 } from 'uuid'

import type { TestData, UploadType } from '../types.js'
import { batchAndPostEvents } from '../util.js'
import { DATA_BATCH_ENDPOINT } from '../constants.js'
import { BStackLogger } from '../bstackLogger.js'
import { BrowserstackCLI } from '../cli/index.js'
import { GrpcClient } from '../cli/grpcClient.js'
import { enumerateSpecs } from './specEnumerator.js'

/**
 * wdio's top-level `bail` stops the launcher scheduling further spec files once N runners have
 * failed — those files never reach a worker, so nothing in them is ever reported and the tests
 * simply vanish from the run. (This is distinct from mocha's `bail`, which drops the remaining
 * tests inside a spec that IS running; that case is handled worker-side in service.afterTest.)
 *
 * Here we enumerate the dropped spec files and report their tests as skipped, so the Test Run
 * accounts for every declared case.
 *
 * Emitting over HTTP from the launcher mirrors `finalizeOrphanedRuns` — by this point the
 * workers, and their gRPC trackers, are gone.
 */

/**
 * Expand a wdio `specs` config (glob patterns, plain paths, or nested arrays used for grouping)
 * into absolute file paths. Mirrors what the runner does when it builds its schedule.
 */
export async function resolveSpecPatterns(specs: unknown[], rootDir: string): Promise<string[]> {
    const out: string[] = []
    try {
        const { sync: globSync } = await import('glob')
        for (const entry of (specs || []).flat(2)) {
            if (typeof entry !== 'string') {
                continue
            }
            if (entry.startsWith('file://')) {
                out.push(entry.replace(/^file:\/\//, ''))
                continue
            }
            const pattern = entry.replace(/\\/g, '/')
            const matches = globSync(pattern, { cwd: rootDir, absolute: true })
            if (matches.length) {
                out.push(...matches)
            } else if (!pattern.includes('*')) {
                out.push(path.resolve(rootDir, pattern))
            }
        }
    } catch (e) {
        BStackLogger.debug('unlaunchedSpecReporter: failed to resolve spec patterns: ' + e)
    }
    return [...new Set(out)]
}

/**
 * On the CLI/gRPC path the launcher's `BROWSERSTACK_TESTHUB_JWT` is the binary's account-auth
 * token — it carries no build claim, so posting straight to the collector's batch endpoint
 * returns 401. Relay through the binary instead; it holds the build-scoped credential.
 * Falls back to the direct HTTP batch when no binary is running.
 */
export async function emitEvents(events: UploadType[]): Promise<void> {
    if (!BrowserstackCLI.getInstance().isRunning()) {
        await batchAndPostEvents(DATA_BATCH_ENDPOINT, 'UNLAUNCHED_SPEC_SKIP_REPORTING', events)
        return
    }
    // the binary's handler takes one event per call, not a batch
    for (const event of events) {
        await GrpcClient.getInstance().enqueueTestEvent(DATA_BATCH_ENDPOINT, event)
    }
}

export function findUnlaunchedSpecs(allSpecs: string[], dispatchedSpecs: Set<string>): string[] {
    const normalize = (s: string) => path.resolve(s.startsWith('file://') ? s.replace(/^file:\/\//, '') : s)
    const dispatched = new Set([...dispatchedSpecs].map(normalize))
    return allSpecs.filter((spec) => !dispatched.has(normalize(spec)))
}

/**
 * Mirrors wdio's own `ConfigParser.filterSpecs`: when every exclude entry looks like a path
 * (contains a separator or a glob) it matches exactly, otherwise entries are treated as
 * substrings — `exclude: ['flaky']` drops any spec whose path contains "flaky". Matching only
 * on resolved paths would silently under-exclude and report those specs as skipped.
 */
export function applyExcludes(specs: string[], excludes: string[], rootDir: string): string[] {
    if (!excludes?.length) {
        return specs
    }
    const pathLike = excludes.every(e => e.includes('/') || e.includes('\\') || e.includes('*'))
    if (pathLike) {
        const resolved = new Set(excludes.map(e => path.resolve(rootDir, e)))
        return specs.filter(spec => !resolved.has(path.resolve(spec)))
    }
    return specs.filter(spec => !excludes.some(e => spec.includes(e)))
}

/**
 * Per-capability `wdio:specs` / `wdio:exclude` mean the set of specs a run was ever going to
 * execute cannot be derived from the top-level config alone. Rather than guess and risk
 * reporting a deliberately-excluded spec as skipped, we opt out of reporting entirely.
 */
export function hasPerCapabilitySpecFilters(capabilities: unknown): boolean {
    const caps = Array.isArray(capabilities)
        ? capabilities
        : Object.values((capabilities ?? {}) as Record<string, { capabilities?: unknown }>).map(c => c?.capabilities ?? c)

    return caps.some((cap) => {
        const c = (cap ?? {}) as Record<string, unknown>
        // multiremote nests the real caps one level down
        const nested = (c.capabilities ?? {}) as Record<string, unknown>
        return Boolean(
            c['wdio:specs'] || c['wdio:exclude'] || c.specs || c.exclude ||
            nested['wdio:specs'] || nested['wdio:exclude']
        )
    })
}

export async function reportUnlaunchedSpecs(
    allSpecs: string[],
    dispatchedSpecs: Set<string>,
    cwd: string = process.cwd()
): Promise<number> {
    try {
        const unlaunched = findUnlaunchedSpecs(allSpecs, dispatchedSpecs)
        if (!unlaunched.length) {
            return 0
        }
        BStackLogger.debug(`unlaunchedSpecReporter: ${unlaunched.length} spec file(s) never ran; enumerating`)

        const tests = await enumerateSpecs(unlaunched, cwd)
        if (!tests.length) {
            return 0
        }

        const at = new Date().toISOString()
        const events: UploadType[] = []
        // rootDir is the wdio config's directory, which may sit below the project root — a
        // relative path from there can escape upwards ('../tests/specs/x.js'). Anchor on cwd
        // and keep the absolute path if the result still escapes, rather than emit a path the
        // backend will reject.
        const relativize = (file: string) => {
            const rel = path.relative(process.cwd(), file)
            return !rel || rel.startsWith('..') ? file : rel
        }
        for (const test of tests) {
            // Same shape `getUniqueIdentifier` produces for tests that DO run, so a test
            // reported skipped here and the same test on a later successful run carry one
            // identity. Mocha's own `fullTitle` (space-joined) would not match.
            const identifier = `${test.scopes.at(-1) ?? ''} - ${test.title}`
            const testData: TestData = {
                uuid: uuidv4(),
                type: 'test',
                name: test.title,
                scope: identifier,
                scopes: test.scopes,
                identifier,
                file_name: relativize(test.file),
                location: relativize(test.file),
                started_at: at,
                finished_at: at,
                duration_in_ms: 0,
                framework: 'mocha',
                result: 'skipped'
            }
            events.push({ event_type: 'TestRunStarted', test_run: testData })
            events.push({ event_type: 'TestRunFinished', test_run: testData })
        }

        await emitEvents(events)
        BStackLogger.info(`Reported ${tests.length} test(s) as skipped from ${unlaunched.length} spec file(s) that never ran`)
        return tests.length
    } catch (e) {
        BStackLogger.debug('unlaunchedSpecReporter: failed to report unlaunched specs: ' + e)
        return 0
    }
}
