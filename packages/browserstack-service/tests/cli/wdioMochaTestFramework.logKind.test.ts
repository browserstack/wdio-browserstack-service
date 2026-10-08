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
    let testLogs: unknown[]
    let openHook: Record<string, unknown> | null
    const instance = { getCurrentTestState: () => TestFrameworkState.LOG, updateMultipleEntries: vi.fn() } as any
    const screenshot = { kind: TestFrameworkConstants.KIND_SCREENSHOT, message: 'b64', timestamp: 't' }
    const consoleLog = { kind: TestFrameworkConstants.KIND_LOG, message: 'hello', level: 'info', timestamp: 't' }

    beforeEach(() => {
        testLogs = []
        openHook = { key: 'BEFORE_EACH', [TestFrameworkConstants.KEY_HOOK_ID]: 'hook-uuid', [TestFrameworkConstants.KEY_HOOK_LOGS]: [] }
        vi.spyOn(TestFramework, 'getState').mockReturnValue(testLogs)
        vi.spyOn(WdioMochaTestFramework, 'lastActiveHook').mockImplementation(() => openHook)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const load = (logEntry: Record<string, unknown>, commandLog: boolean) =>
        WdioMochaTestFramework.prototype.loadLogEntries.call(WdioMochaTestFramework.prototype, instance, TestFrameworkState.LOG, HookState.POST, { ...logEntry }, commandLog)
    const hookLogs = () => openHook![TestFrameworkConstants.KEY_HOOK_LOGS] as Record<string, unknown>[]

    it('stamps the open hook\'s id and state on a command log', () => {
        load(screenshot, true)
        expect(hookLogs()[0]).toMatchObject({ kind: 'TEST_SCREENSHOT', [TestFrameworkConstants.KEY_HOOK_ID]: 'hook-uuid', testFrameworkState: 'BEFORE_EACH' })
    })

    it('leaves a console log in the open hook exactly as before', () => {
        load(consoleLog, false)
        expect(hookLogs()[0]).toEqual({ kind: 'TEST_LOG', message: Buffer.from('hello'), level: 'info', timestamp: 't' })
    })

    it('leaves a command log in the test body on the test', () => {
        openHook = null
        load(screenshot, true)
        expect(testLogs[0]).toEqual({ kind: 'TEST_SCREENSHOT', message: Buffer.from('b64'), level: undefined, timestamp: 't' })
    })
})
