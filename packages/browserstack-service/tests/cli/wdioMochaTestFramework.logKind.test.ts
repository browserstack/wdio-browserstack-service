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

describe('loadLogEntries — WebDriver command logs name the open hook', () => {
    const screenshot = { kind: TestFrameworkConstants.KIND_SCREENSHOT, message: 'b64', timestamp: 't' }
    const consoleLog = { kind: TestFrameworkConstants.KIND_LOG, message: 'hello', level: 'info', timestamp: 't' }
    let state: Record<string, unknown>
    const instance = { getCurrentTestState: () => TestFrameworkState.LOG, updateMultipleEntries: vi.fn() } as any

    // The instance's real shapes: hooks started is a Map of key -> started-and-not-finished hooks
    const startHook = (key: string, hookId: string) => {
        const started = state[TestFrameworkConstants.KEY_HOOKS_STARTED] as Map<string, unknown[]>
        started.set(key, [...(started.get(key) ?? []), { key, [TestFrameworkConstants.KEY_HOOK_ID]: hookId, [TestFrameworkConstants.KEY_HOOK_LOGS]: [] }])
        state[WdioMochaTestFramework.KEY_HOOK_LAST_STARTED] = key
    }
    const finishHook = (key: string) => (state[TestFrameworkConstants.KEY_HOOKS_STARTED] as Map<string, unknown[]>).get(key)!.pop()
    const load = (logEntry: Record<string, unknown>, commandLog: boolean) =>
        WdioMochaTestFramework.prototype.loadLogEntries.call(WdioMochaTestFramework.prototype, instance, TestFrameworkState.LOG, HookState.POST, { ...logEntry }, commandLog)
    const testLogs = () => state[TestFrameworkConstants.KEY_TEST_LOGS] as Record<string, unknown>[]

    beforeEach(() => {
        state = { [TestFrameworkConstants.KEY_HOOKS_STARTED]: new Map(), [TestFrameworkConstants.KEY_TEST_LOGS]: [] }
        vi.spyOn(TestFramework, 'getState').mockImplementation((_i, key) => state[key as string])
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('stamps the open hook\'s id and state on a command log', () => {
        startHook('BEFORE_EACH', 'hook-uuid')
        load(screenshot, true)
        expect(testLogs()[0]).toMatchObject({ kind: 'TEST_SCREENSHOT', [TestFrameworkConstants.KEY_HOOK_ID]: 'hook-uuid', testFrameworkState: 'BEFORE_EACH' })
    })

    it('leaves a command log on the test once the hook has finished, and in the test body', () => {
        startHook('BEFORE_EACH', 'hook-uuid')
        finishHook('BEFORE_EACH')
        load(screenshot, true)
        expect(testLogs()[0]).toEqual({ kind: 'TEST_SCREENSHOT', message: Buffer.from('b64'), level: undefined, timestamp: 't' })
    })

    it('leaves a console log in an open hook exactly as before', () => {
        startHook('BEFORE_EACH', 'hook-uuid')
        load(consoleLog, false)
        expect(testLogs()[0]).toEqual({ kind: 'TEST_LOG', message: Buffer.from('hello'), level: 'info', timestamp: 't' })
    })
})
