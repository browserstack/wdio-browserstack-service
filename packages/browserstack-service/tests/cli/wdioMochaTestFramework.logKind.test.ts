import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as bstackLogger from '../../src/bstackLogger.js'

import WdioMochaTestFramework from '../../src/cli/frameworks/wdioMochaTestFramework.js'
import TestFramework from '../../src/cli/frameworks/testFramework.js'
import { TestFrameworkConstants } from '../../src/cli/frameworks/constants/testFrameworkConstants.js'
import { TestFrameworkState } from '../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../src/cli/states/hookState.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

describe('SDK-4177 — loadLogEntries must not relabel a log that carries its own kind', () => {
    let entries: unknown[]
    let instance: any

    beforeEach(() => {
        entries = []
        instance = {
            getCurrentTestState: () => TestFrameworkState.TEST,
            updateMultipleEntries: vi.fn(),
        }
        vi.spyOn(TestFramework, 'getState').mockReturnValue(entries)
        vi.spyOn(WdioMochaTestFramework, 'lastActiveHook').mockReturnValue(null)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const load = (logEntry: Record<string, unknown>) => {
        WdioMochaTestFramework.prototype.loadLogEntries.call(
            WdioMochaTestFramework.prototype,
            instance,
            TestFrameworkState.LOG,
            HookState.POST,
            logEntry
        )
        return entries[0] as Record<string, unknown>
    }

    it('keeps TEST_SCREENSHOT, which the kind was previously hardcoded over', () => {
        // Hardcoding KIND_LOG here meant a screenshot reached Observability labelled as a
        // console log, so no screenshots manifest was ever built for the test run.
        const record = load({
            kind: TestFrameworkConstants.KIND_SCREENSHOT,
            message: 'aBase64Screenshot',
            timestamp: '2020-01-01T00:00:00.000Z',
        })

        expect(record.kind).toBe('TEST_SCREENSHOT')
        expect(record.message).toEqual(Buffer.from('aBase64Screenshot'))
    })

    it('still labels a console log TEST_LOG', () => {
        const record = load({
            kind: TestFrameworkConstants.KIND_LOG,
            message: 'hello',
            level: 'info',
            timestamp: '2020-01-01T00:00:00.000Z',
        })

        expect(record.kind).toBe('TEST_LOG')
        expect(record.level).toBe('info')
    })

    it('falls back to TEST_LOG for an entry with no kind', () => {
        expect(load({ message: 'hello', timestamp: '2020-01-01T00:00:00.000Z' }).kind).toBe('TEST_LOG')
    })
})
