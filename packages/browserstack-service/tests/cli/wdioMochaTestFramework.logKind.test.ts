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

describe('mocha WebDriver command logs follow the hook or test that started last', () => {
    const screenshot = { kind: TestFrameworkConstants.KIND_SCREENSHOT, message: 'b64', timestamp: 't' }
    const http = { kind: 'HTTP', message: '{}', timestamp: 't' }
    const consoleLog = { kind: TestFrameworkConstants.KIND_LOG, message: 'hello', level: 'info', timestamp: 't' }
    let state: Record<string, unknown>
    let framework: WdioMochaTestFramework
    const instance = {
        getCurrentTestState: () => TestFrameworkState.LOG, getCurrentHookState: () => HookState.POST, updateMultipleEntries: vi.fn(), getAllData: () => new Map(),
        setLastTestState: vi.fn(), setLastHookState: vi.fn(), setCurrentTestState: vi.fn(), setCurrentHookState: vi.fn(),
    } as any

    const startHook = (key: string, hookId: string) => {
        const started = state[TestFrameworkConstants.KEY_HOOKS_STARTED] as Map<string, unknown[]>
        started.set(key, [...(started.get(key) ?? []), { key, [TestFrameworkConstants.KEY_HOOK_ID]: hookId, [TestFrameworkConstants.KEY_HOOK_LOGS]: [] }])
        state[WdioMochaTestFramework.KEY_HOOK_LAST_STARTED] = key
    }
    const finishHook = (key: string) => (state[TestFrameworkConstants.KEY_HOOKS_STARTED] as Map<string, unknown[]>).get(key)!.pop()
    const event = (testFrameworkState: State, hookState: State, args: Record<string, unknown> = {}) => framework.trackEvent(testFrameworkState, hookState, args)
    const load = (logEntry: Record<string, unknown>, commandLog: boolean) =>
        framework.loadLogEntries(instance, TestFrameworkState.LOG, HookState.POST, { ...logEntry }, commandLog)
    const testLogs = () => state[TestFrameworkConstants.KEY_TEST_LOGS] as Record<string, unknown>[]

    beforeEach(() => {
        state = { [TestFrameworkConstants.KEY_HOOKS_STARTED]: new Map(), [TestFrameworkConstants.KEY_HOOKS_FINISHED]: new Map(), [TestFrameworkConstants.KEY_TEST_LOGS]: [] }
        vi.spyOn(TestFramework, 'getState').mockImplementation((_i, key) => state[key as string])
        framework = new WdioMochaTestFramework(['WebdriverIO-mocha'], { 'WebdriverIO-mocha': '9.0.0' }, 'bin')
        vi.spyOn(framework, 'resolveInstance').mockReturnValue(instance)
        vi.spyOn(framework, 'runHooks').mockResolvedValue(undefined)
        vi.spyOn(framework, 'trackHookEvents').mockImplementation(async (_i, testFrameworkState, hookState) => {
            const key = testFrameworkState.toString().split('.')[1]
            if (hookState === HookState.PRE) {
                startHook(key, `${key}-uuid`)
            } else {
                finishHook(key)
            }
        })
        vi.spyOn(framework as never, 'getTestData').mockResolvedValue({} as never)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('stamps a command log in a hook with that hook\'s id and state, even after the hook finished', async () => {
        await event(TestFrameworkState.AFTER_ALL, HookState.PRE, { test: {} })
        load(http, true)
        await event(TestFrameworkState.AFTER_ALL, HookState.POST, { test: {} })
        load(http, true)
        expect(testLogs().map(l => [l[TestFrameworkConstants.KEY_HOOK_ID], l.testFrameworkState])).toEqual([['AFTER_ALL-uuid', 'AFTER_ALL'], ['AFTER_ALL-uuid', 'AFTER_ALL']])
    })

    it('leaves a command log on the test once a test has started, and a skip report never takes it', async () => {
        await event(TestFrameworkState.BEFORE_EACH, HookState.PRE, { test: {} })
        await event(TestFrameworkState.BEFORE_EACH, HookState.POST, { test: {} })
        await event(TestFrameworkState.TEST, HookState.PRE, { test: { title: 't' } })
        load(screenshot, true)
        await event(TestFrameworkState.AFTER_EACH, HookState.PRE, { test: {} })
        await event(TestFrameworkState.TEST, HookState.PRE, { test: { title: 'skipped' }, skipReport: true })
        load(screenshot, true)
        expect(testLogs()[0]).toEqual({ kind: 'TEST_SCREENSHOT', message: Buffer.from('b64'), level: undefined, timestamp: 't' })
        expect(testLogs()[1]).toMatchObject({ [TestFrameworkConstants.KEY_HOOK_ID]: 'AFTER_EACH-uuid', testFrameworkState: 'AFTER_EACH' })
    })

    it('attaches command logs from a test\'s start-up to that test', async () => {
        vi.mocked(framework.runHooks).mockImplementation(async (_i, testFrameworkState, hookState) => {
            if (testFrameworkState === TestFrameworkState.TEST && hookState === HookState.PRE) {
                await event(TestFrameworkState.LOG, HookState.POST, { logEntry: { ...http }, commandLog: true })
                await event(TestFrameworkState.LOG, HookState.POST, { logEntry: { ...consoleLog } })
            }
        })
        const loadLogEntries = vi.spyOn(framework, 'loadLogEntries')
        await event(TestFrameworkState.TEST, HookState.PRE, { test: { title: 't' } })
        await event(TestFrameworkState.LOG, HookState.POST, { logEntry: { ...http }, commandLog: true })
        expect(loadLogEntries.mock.calls.map(([, , , logEntry, commandLog]) => [logEntry.kind, commandLog])).toEqual([['HTTP', true], ['TEST_LOG', false], ['HTTP', true]])
        expect(loadLogEntries.mock.calls[0][0]).toBe(instance)
    })

    it('keeps a command log outside any hook on the last test that ran, never a skip report\'s test', async () => {
        const ran = { ...instance, setCurrentTestState: vi.fn() }
        const skipped = { ...instance }
        vi.mocked(framework.resolveInstance).mockReturnValueOnce(ran).mockReturnValue(skipped)
        await event(TestFrameworkState.TEST, HookState.PRE, { test: { title: 'ran' } })
        await event(TestFrameworkState.INIT_TEST, HookState.PRE, { test: { title: 'skipped' } })
        await event(TestFrameworkState.TEST, HookState.PRE, { test: { title: 'skipped' }, skipReport: true })
        const loadLogEntries = vi.spyOn(framework, 'loadLogEntries')
        await event(TestFrameworkState.LOG, HookState.POST, { logEntry: { ...http }, commandLog: true })
        expect(loadLogEntries.mock.calls[0][0]).toBe(ran)
        expect(ran.setCurrentTestState).toHaveBeenCalledWith(TestFrameworkState.LOG)
    })

    it('leaves a console log in a hook exactly as before', async () => {
        await event(TestFrameworkState.BEFORE_EACH, HookState.PRE, { test: {} })
        load(consoleLog, false)
        expect(testLogs()[0]).toEqual({ kind: 'TEST_LOG', message: Buffer.from('hello'), level: 'info', timestamp: 't' })
    })
})
