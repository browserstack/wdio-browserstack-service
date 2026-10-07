import path from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import * as bstackLogger from '../../src/bstackLogger.js'
import WdioJasmineTestFramework from '../../src/cli/frameworks/wdioJasmineTestFramework.js'
import TestFramework from '../../src/cli/frameworks/testFramework.js'
import { TestFrameworkState } from '../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../src/cli/states/hookState.js'
import type TestFrameworkInstance from '../../src/cli/instances/testFrameworkInstance.js'
import TestHubModule from '../../src/cli/modules/testHubModule.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

const SUITE_FILE = path.join(process.cwd(), 'test/p2/nested.spec.js')
const BEFORE_ALL_REASON = 'Not run because a beforeAll function failed. The beforeAll failure will be reported on the suite that caused it.'

interface Dispatch {
    state: State
    hook: State
    data: Record<string, unknown>
    args: Record<string, unknown>
}

const snapshot = (instance: TestFrameworkInstance) =>
    JSON.parse(JSON.stringify(Object.fromEntries(instance.getAllData()), (_k, v) => v instanceof Map ? Object.fromEntries(v) : v))

const testStats = (overrides: Record<string, unknown> = {}) => ({
    type: 'test',
    uid: 'outer passing test0',
    title: 'outer passing test',
    fullTitle: 'Nested outer outer passing test',
    start: new Date('2026-09-25T15:34:12.259Z'),
    end: undefined as Date | undefined,
    _duration: 0,
    retries: 0,
    state: 'pending',
    ...overrides,
})

const hookStats = (title: string, overrides: Record<string, unknown> = {}) => ({
    type: 'hook',
    uid: title,
    title,
    start: new Date('2026-09-25T15:34:08.170Z'),
    end: undefined as Date | undefined,
    _duration: 0,
    ...overrides,
})

const context = (scopes = ['Nested outer']) => ({ scopes, suiteFile: SUITE_FILE })

describe('WdioJasmineTestFramework', () => {
    let framework: WdioJasmineTestFramework
    // what reached TestHub (reporter path) and what reached the module observers (service path)
    let dispatches: Dispatch[]
    let moduleDispatches: Dispatch[]
    let logSends: Array<{ state: string, entries: Record<string, unknown>[], data: Record<string, unknown> }>
    let sessionEvents: number
    let testHub: Record<string, ReturnType<typeof vi.fn>>

    const drain = () => framework.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, {})
    // The reporter does not await trackEvent: its events are applied before the call returns.
    const reporterTestStart = (testStats: unknown, ctx: unknown) => {
        const args: Record<string, unknown> = { source: 'reporter', testStats, context: ctx }
        framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, args)
        return args.testUuid as string | undefined
    }
    const reporterTestEnd = (testStats: unknown, ctx: unknown) => {
        framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { source: 'reporter', testStats, context: ctx })
    }
    const reporterHook = (hookState: State, hookStats: { title: string }, ctx: unknown) => {
        framework.trackEvent(WdioJasmineTestFramework.reporterHookState(hookStats.title), hookState, { source: 'reporter', hookStats, context: ctx })
    }
    const reporterHookStart = (hookStats: { title: string }, ctx: unknown) => reporterHook(HookState.PRE, hookStats, ctx)
    const reporterHookEnd = (hookStats: { title: string }, ctx: unknown = context()) => reporterHook(HookState.POST, hookStats, ctx)
    const reporterLog = (logEntry: Record<string, unknown>) => {
        framework.trackEvent(TestFrameworkState.LOG, HookState.POST, { source: 'reporter', logEntry })
    }

    beforeEach(() => {
        process.env.BROWSERSTACK_OBSERVABILITY = 'true'
        framework = new WdioJasmineTestFramework(['WebdriverIO-jasmine'], { 'WebdriverIO-jasmine': '9.39.0' }, 'bin-session')
        dispatches = []
        moduleDispatches = []
        logSends = []
        sessionEvents = 0
        testHub = {
            onBeforeTest: vi.fn(() => { sessionEvents++ }),
            sendTestFrameworkEvent: vi.fn(async (args: Record<string, unknown>) => {
                const instance = args.instance as TestFrameworkInstance
                dispatches.push({ state: instance.getCurrentTestState(), hook: instance.getCurrentHookState(), data: snapshot(instance), args })
                return true
            }),
            sendLogCreatedEvent: vi.fn(async (args: Record<string, unknown>) => {
                const instance = args.instance as TestFrameworkInstance
                logSends.push({ state: instance.getCurrentTestState().toString(), entries: args.logEntries as Record<string, unknown>[], data: snapshot(instance) })
            }),
        }
        framework.setTestHubModule(testHub as unknown as TestHubModule)
        vi.spyOn(framework, 'runHooks').mockImplementation(async (instance, state, hook, args) => {
            moduleDispatches.push({ state, hook, data: snapshot(instance), args: args as Record<string, unknown> })
        })
    })

    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env.BROWSERSTACK_OBSERVABILITY
    })

    it('sends legacy identity for a spec, char-for-char with the CP0 TestRun', async () => {
        reporterTestStart(testStats(), context())
        await drain()

        expect(dispatches).toHaveLength(1)
        const [{ state, hook, data, args }] = dispatches
        expect([state, hook]).toEqual([TestFrameworkState.TEST, HookState.PRE])
        expect(data.test_name).toBe('outer passing test')
        expect(data.test_id).toBe('Nested outer outer passing test')
        expect(data.test_scope).toBe('Nested outer outer passing test')
        expect(data.test_scopes).toEqual(['Nested outer'])
        expect(data.test_tags).toEqual([])
        expect(data.test_file_path).toBe(SUITE_FILE)
        expect(data.test_location).toBe('test/p2/nested.spec.js')
        expect(data.test_framework_name).toBe('WebdriverIO-jasmine')
        expect(data.test_retries).toEqual({ limit: 0, attempts: 0 })
        expect(data.test_started_at).toBe('2026-09-25T15:34:12.259Z')
        expect(data.test_duration).toBe(0)
        expect(data.test_result).toBe('pending')
        expect('test_code' in data).toBe(false)
        expect(args.suiteTitle).toBe('Nested outer')
        expect(args.test).toEqual({ description: 'outer passing test', fullName: 'Nested outer outer passing test', file: SUITE_FILE })
    })

    it('keeps @tags from describes and the spec, sigil included', async () => {
        reporterTestStart(testStats({ title: 'tagged @smoke', fullTitle: 'Outer @regression tagged @smoke' }), context(['Outer @regression']))
        await drain()
        expect(dispatches[0].data.test_tags).toEqual(['@regression', '@smoke'])
    })

    it('finishes a passed spec on the same uuid with reporter timing and the result timestamp', async () => {
        const stats = testStats()
        reporterTestStart(stats, context())
        reporterTestEnd({ ...stats, state: 'passed', end: new Date('2026-09-25T15:34:16.645Z'), _duration: 4386 }, context())
        await drain()

        expect(dispatches.map(d => [d.state, d.hook])).toEqual([[TestFrameworkState.TEST, HookState.PRE], [TestFrameworkState.TEST, HookState.POST]])
        const [start, finish] = dispatches
        expect(finish.data.test_uuid).toBe(start.data.test_uuid)
        expect(finish.data.test_result).toBe('passed')
        expect(finish.data.test_started_at).toBe('2026-09-25T15:34:12.259Z')
        expect(finish.data.test_ended_at).toBe('2026-09-25T15:34:16.645Z')
        expect(finish.data.test_duration).toBe(4386)
        expect(typeof finish.data.test_result_at).toBe('string')
        expect('test_failure' in finish.data).toBe(false)
        expect(finish.args.result).toMatchObject({ passed: true, skipped: false })
    })

    it('reports a pending spec as Start + Finish(skipped)', async () => {
        reporterTestStart(testStats({ uid: 'xit0', title: 'xit skipped test', fullTitle: 'Pending suite xit skipped test' }), context(['Pending suite']))
        // @wdio/reporter replaces the TestStats object on test:pending; only the uid carries over
        reporterTestEnd(testStats({ uid: 'xit0', title: 'xit skipped test', fullTitle: 'Pending suite xit skipped test', state: 'skipped', end: new Date() }), context(['Pending suite']))
        await drain()

        expect(dispatches).toHaveLength(2)
        expect(dispatches[1].data.test_result).toBe('skipped')
        expect(dispatches[1].data.test_duration).toBe(0)
        expect(dispatches[1].args.result).toMatchObject({ passed: false, skipped: true })
    })

    it('keeps jasmine\'s exact reason on a beforeAll-failed child', async () => {
        const error = { message: BEFORE_ALL_REASON, stack: '' }
        reporterTestStart(testStats({ uid: 'child0' }), context())
        reporterTestEnd(testStats({ uid: 'child0', state: 'failed', error, end: new Date() }), context())
        await drain()

        const finish = dispatches[1].data
        expect(finish.test_result).toBe('failed')
        expect(finish.test_failure_reason).toBe(BEFORE_ALL_REASON)
        expect(finish.test_failure_type).toBe('UnhandledError')
        expect(finish.test_failure).toEqual([{ backtrace: [BEFORE_ALL_REASON, ''] }])
    })

    it('maps an AssertionError message to failure_type AssertionError', async () => {
        reporterTestStart(testStats(), context())
        reporterTestEnd(testStats({ state: 'failed', error: { message: 'AssertionError: nope', stack: 'at x' } }), context())
        await drain()
        expect(dispatches[1].data.test_failure_type).toBe('AssertionError')
    })

    it('gives overlapping specs distinct instances and closes each on its own uuid', async () => {
        reporterTestStart(testStats({ uid: 'a' }), context())
        reporterTestStart(testStats({ uid: 'b', title: 'b', fullTitle: 'Nested outer b' }), context())
        reporterTestEnd(testStats({ uid: 'a', state: 'passed', end: new Date() }), context())
        reporterTestEnd(testStats({ uid: 'b', title: 'b', fullTitle: 'Nested outer b', state: 'passed', end: new Date() }), context())
        await drain()

        const uuidOf = (i: number) => dispatches[i].data.test_uuid
        expect(uuidOf(0)).not.toBe(uuidOf(1))
        expect(uuidOf(2)).toBe(uuidOf(0))
        expect(uuidOf(3)).toBe(uuidOf(1))
        expect(dispatches[2].data.test_id).toBe('Nested outer outer passing test')
    })

    it('reports beforeAll/afterAll with legacy hook identity and no test linkage', async () => {
        const before = hookStats('"before all" hook')
        reporterHookStart(before, context())
        reporterHookEnd({ ...before, state: 'passed', end: new Date('2026-09-25T15:34:12.257Z'), _duration: 4087 })
        const after = hookStats('"after all" hook')
        reporterHookStart(after, context(['Nested outer', 'Nested middle']))
        reporterHookEnd({ ...after, state: 'passed', end: new Date() })
        await drain()

        expect(dispatches.map(d => [d.state, d.hook])).toEqual([
            [TestFrameworkState.BEFORE_ALL, HookState.PRE],
            [TestFrameworkState.BEFORE_ALL, HookState.POST],
            [TestFrameworkState.AFTER_ALL, HookState.PRE],
            [TestFrameworkState.AFTER_ALL, HookState.POST],
        ])
        const started = (dispatches[0].data.test_hooks_started as Record<string, Record<string, unknown>[]>).BEFORE_ALL[0]
        expect(started).toMatchObject({
            key: 'BEFORE_ALL',
            hook_name: '"before all" hook',
            hook_identifier: '"before all" hook for Nested outer',
            hook_scope: 'Nested outer - "before all" hook',
            hook_scopes: ['Nested outer'],
            hook_result: 'pending',
            event_started_at: '2026-09-25T15:34:08.170Z',
            test_file_path: SUITE_FILE,
        })
        const finished = (dispatches[1].data.test_hooks_finished as Record<string, Record<string, unknown>[]>).BEFORE_ALL[0]
        expect(finished).toMatchObject({ hook_result: 'passed', event_ended_at: '2026-09-25T15:34:12.257Z', hook_duration: 4087 })
        expect(finished.hook_id).toBe(started.hook_id)
        expect('hook_failure' in finished).toBe(false)
        // the session event is keyed by the hook's own uuid, so the hook run gets its platform and session (#23);
        // the binary builds the HookRun from hook_id and never links it to a test (#25)
        expect(dispatches[0].data.test_uuid).toBe(started.hook_id)
        expect(testHub.onBeforeTest).toHaveBeenCalledTimes(2)
        expect(testHub.onBeforeTest.mock.calls.map(([args]) => (args as Record<string, unknown>).instance)).toEqual([dispatches[0].args.instance, dispatches[2].args.instance])

        const afterStarted = (dispatches[2].data.test_hooks_started as Record<string, Record<string, unknown>[]>).AFTER_ALL[0]
        expect(afterStarted.hook_identifier).toBe('"after all" hook for Nested middle')
        expect(afterStarted.hook_scope).toBe('Nested outer - "after all" hook')
    })

    it('carries failure fields on a failed beforeAll', async () => {
        const before = hookStats('"before all" hook')
        reporterHookStart(before, context())
        reporterHookEnd({ ...before, state: 'failed', error: { message: 'boom', stack: 'Error: boom' }, end: new Date() })
        await drain()
        const finished = (dispatches[1].data.test_hooks_finished as Record<string, Record<string, unknown>[]>).BEFORE_ALL[0]
        expect(finished).toMatchObject({
            hook_result: 'failed',
            hook_failure: [{ backtrace: ['boom', 'Error: boom'] }],
            hook_failure_reason: 'boom',
            hook_failure_type: 'UnhandledError',
        })
    })

    it('never reports each-hooks, or a hook outside any describe', async () => {
        reporterHookStart(hookStats('"before each" hook'), context())
        reporterHookStart(hookStats('"before all" hook'), context([]))
        await drain()
        expect(dispatches).toHaveLength(0)
    })

    it('suppresses hook and log families in an accessibility-only run, like the legacy Listener', async () => {
        delete process.env.BROWSERSTACK_OBSERVABILITY
        process.env.BROWSERSTACK_ACCESSIBILITY = 'true'
        try {
            const before = hookStats('"before all" hook')
            reporterHookStart(before, context())
            reporterHookEnd({ ...before, state: 'passed', end: new Date() })
            reporterTestStart(testStats(), context())
            reporterLog({ level: 'INFO', message: 'hi', timestamp: 't', kind: 'TEST_LOG' })
            await drain()
            expect(dispatches.map(d => d.state)).toEqual([TestFrameworkState.TEST])
            expect(logSends).toHaveLength(0)
        } finally {
            delete process.env.BROWSERSTACK_ACCESSIBILITY
        }
    })

    it('sends reporter events to TestHub only, never through the module observers', async () => {
        const stats = testStats()
        reporterTestStart(stats, context())
        reporterTestEnd({ ...stats, state: 'passed', end: new Date() }, context())
        await drain()
        expect(testHub.sendTestFrameworkEvent).toHaveBeenCalledTimes(2)
        expect(sessionEvents).toBe(1)
        expect(moduleDispatches).toHaveLength(0)
    })

    it('drives the modules from the service hooks on the reporter\'s instance, with TestHub skipped', async () => {
        const spec = { description: 'outer passing test', fullName: 'Nested outer outer passing test' }
        reporterTestStart(testStats(), context())
        await framework.trackEvent(TestFrameworkState.INIT_TEST, HookState.PRE, { test: spec })
        const uuid = dispatches[0].data.test_uuid
        expect(TestFramework.getState(TestFramework.getTrackedInstance(), 'test_uuid')).toBe(uuid)
        expect(process.env.TEST_ANALYTICS_ID).toBe(uuid)

        await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { test: spec, suiteTitle: 'Nested outer' })
        await framework.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test: spec, result: {} })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test: spec, result: { passed: true }, suiteTitle: 'Jasmine__TopLevel__Suite' })

        expect(moduleDispatches.map(d => [d.state, d.hook])).toEqual([[TestFrameworkState.TEST, HookState.PRE], [TestFrameworkState.TEST, HookState.POST]])
        for (const d of moduleDispatches) {
            expect(d.args.skipTestHub).toBe(true)
            expect(d.data.test_uuid).toBe(uuid)
        }
        expect(moduleDispatches[1].args.suiteTitle).toBe('Nested outer')
        expect(moduleDispatches[1].args.result).toEqual({ passed: true })
        expect(testHub.sendTestFrameworkEvent).toHaveBeenCalledTimes(1)
    })

    it('never shows a spec the reporter saw but the service did not (pending, excluded, beforeAll-failed) to the modules', async () => {
        reporterTestStart(testStats({ uid: 'x' }), context())
        reporterTestEnd(testStats({ uid: 'x', state: 'skipped', end: new Date() }), context())
        await drain()
        expect(dispatches).toHaveLength(2)
        expect(moduleDispatches).toHaveLength(0)
    })

    it('still drives the modules when Test Observability is opted out and the reporter feeds nothing', async () => {
        const spec = { description: 'a', fullName: 'Suite a', file: SUITE_FILE }
        await framework.trackEvent(TestFrameworkState.INIT_TEST, HookState.PRE, { test: spec })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { test: spec, suiteTitle: 'Suite' })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test: spec, result: { passed: true } })
        expect(moduleDispatches).toHaveLength(2)
        expect(moduleDispatches[0].data.test_uuid).toBe(moduleDispatches[1].data.test_uuid)
        expect(process.env.TEST_ANALYTICS_ID).toBe(moduleDispatches[0].data.test_uuid)
        expect(testHub.sendTestFrameworkEvent).not.toHaveBeenCalled()
    })

    it('sends an open all-hook\'s logs in the hook state, else the last-started spec\'s in the test state', async () => {
        reporterTestStart(testStats(), context())
        reporterLog({ level: 'INFO', message: 'in test', timestamp: 't1', kind: 'TEST_LOG' })
        const after = hookStats('"after all" hook')
        reporterHookStart(after, context())
        reporterLog({ level: 'INFO', message: 'in hook', timestamp: 't2', kind: 'TEST_LOG' })
        reporterHookEnd({ ...after, state: 'passed', end: new Date() })
        reporterLog({ level: 'INFO', message: 'after hook', timestamp: 't3', kind: 'TEST_LOG' })
        await drain()

        expect(logSends.map(l => l.state)).toEqual(['TestFrameworkState.TEST', 'TestFrameworkState.AFTER_ALL', 'TestFrameworkState.TEST'])
        const specUuid = dispatches[0].data.test_uuid
        expect(logSends[0].data.test_uuid).toBe(specUuid)
        expect(logSends[0].entries[0]).not.toHaveProperty('hook_id')
        const hookId = (dispatches.find(d => d.state === TestFrameworkState.AFTER_ALL)!.data.test_hooks_started as Record<string, Record<string, unknown>[]>).AFTER_ALL[0].hook_id
        expect(logSends[1].entries[0].hook_id).toBe(hookId)
        expect(logSends[2].data.test_uuid).toBe(specUuid)
    })

    const commandLog = (logEntry: Record<string, unknown>) =>
        framework.trackEvent(TestFrameworkState.LOG, HookState.POST, { logEntry, commandLog: true })

    it('keeps a screenshot entry\'s kind on the log path', async () => {
        reporterTestStart(testStats(), context())
        await commandLog({ kind: 'TEST_SCREENSHOT', message: 'b64', timestamp: 't', level: 'INFO' })
        await drain()
        expect(logSends[0].entries[0].kind).toBe('TEST_SCREENSHOT')
    })

    it('sends a command log to the last started spec, even inside an all-hook or after the spec ended', async () => {
        const first = testStats()
        const uuid = reporterTestStart(first, context())
        reporterTestEnd({ ...first, state: 'passed', end: new Date() }, context())
        const after = hookStats('"after all" hook')
        reporterHookStart(after, context())
        const message = JSON.stringify({ path: '/session/:sessionId/title', method: 'GET', body: {}, response: { value: 'StackDemo' } })
        await commandLog({ kind: 'HTTP', message, timestamp: 't' })
        reporterLog({ level: 'INFO', message: 'console in hook', timestamp: 't2', kind: 'TEST_LOG' })
        await drain()

        expect(logSends.map(l => l.state)).toEqual(['TestFrameworkState.TEST', 'TestFrameworkState.AFTER_ALL'])
        expect(logSends[0].data.test_uuid).toBe(uuid)
        expect(logSends[0].entries[0]).toMatchObject({ kind: 'HTTP', timestamp: 't' })
        expect(logSends[0].entries[0]).not.toHaveProperty('hook_id')
        expect(Buffer.from(logSends[0].entries[0].message as Uint8Array).toString()).toBe(message)
        expect(logSends[1].entries[0]).toHaveProperty('hook_id')
    })

    it('drops command logs before the first spec, even inside an all-hook', async () => {
        reporterHookStart(hookStats('"before all" hook'), context())
        await commandLog({ kind: 'HTTP', message: '{}', timestamp: 't' })
        await drain()
        expect(logSends).toHaveLength(0)
    })

    it('drops command logs after an <unknown test> until the next spec, while console logs keep the last spec', async () => {
        const first = testStats()
        reporterTestStart(first, context())
        reporterTestEnd({ ...first, state: 'passed', end: new Date() }, context())
        framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { source: 'reporter', unknownTest: true })
        await commandLog({ kind: 'HTTP', message: '{}', timestamp: 't1' })
        reporterLog({ level: 'INFO', message: 'console', timestamp: 't2', kind: 'TEST_LOG' })
        const second = reporterTestStart(testStats({ uid: 'second', title: 'second', fullTitle: 'Nested outer second' }), context())
        await commandLog({ kind: 'HTTP', message: '{}', timestamp: 't3' })
        await drain()

        expect(logSends.map(l => l.entries[0].timestamp)).toEqual(['t2', 't3'])
        expect(logSends[1].data.test_uuid).toBe(second)
        expect(dispatches.filter(d => d.state === TestFrameworkState.TEST && d.hook === HookState.PRE)).toHaveLength(2)
    })

    it('maps the WDIO hookName to the hook-type key, and nothing else', () => {
        expect(['beforeAll', 'afterAll', 'beforeEach', 'afterEach'].map(n => WdioJasmineTestFramework.hookTypeFromName(n)))
            .toEqual(['BEFORE_ALL', 'AFTER_ALL', 'BEFORE_EACH', 'AFTER_EACH'])
        expect(WdioJasmineTestFramework.hookTypeFromName(undefined)).toBe('unknown')
        expect(WdioJasmineTestFramework.hookTypeFromName('constructor')).toBe('unknown')
    })

    it('ignores the service\'s hook events: hooks reach TestHub from the reporter only', async () => {
        await framework.trackEvent(TestFrameworkState.BEFORE_EACH, HookState.PRE, { test: { fullName: 'Nested outer outer passing test' } })
        await framework.trackEvent(TestFrameworkState.BEFORE_ALL, HookState.POST, { test: {}, result: { passed: false } })
        expect(dispatches).toHaveLength(0)
        expect(moduleDispatches).toHaveLength(0)
    })

    it('is not idle until queued events are dispatched', async () => {
        reporterTestStart(testStats(), context())
        expect(framework.isIdle()).toBe(false)
        await drain()
        expect(framework.isIdle()).toBe(true)
    })

    it('counts pending events per framework instance', async () => {
        const other = new WdioJasmineTestFramework(['WebdriverIO-jasmine'], { 'WebdriverIO-jasmine': '9.39.0' }, 'bin-session')
        reporterTestStart(testStats(), context())
        expect(framework.isIdle()).toBe(false)
        expect(other.isIdle()).toBe(true)
        await drain()
    })

    it('mints a reporter spec before trackEvent returns, so the uuid and the service lookup are immediate', async () => {
        const args: Record<string, unknown> = { source: 'reporter', testStats: testStats(), context: context() }
        const pending = framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, args)
        const uuid = args.testUuid
        expect(uuid).toEqual(expect.any(String))
        expect(TestFramework.getState(TestFramework.getTrackedInstance(), 'test_uuid')).toBe(uuid)
        expect(dispatches).toHaveLength(0)

        await framework.trackEvent(TestFrameworkState.INIT_TEST, HookState.PRE, { test: { description: 'outer passing test', fullName: 'Nested outer outer passing test' } })
        await pending
        expect(process.env.TEST_ANALYTICS_ID).toBe(uuid)
        expect(dispatches[0].data.test_uuid).toBe(uuid)
    })

    it('leaves no uuid on the args when minting fails, and logs instead of throwing', async () => {
        const args: Record<string, unknown> = { source: 'reporter', testStats: undefined, context: context() }
        await expect(framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, args)).resolves.toBeUndefined()
        expect(args.testUuid).toBeUndefined()
        expect(framework.isIdle()).toBe(true)
    })

    it('reports a hook in BEFORE_ALL/AFTER_ALL and every other hook in NONE', () => {
        expect(['"before all" hook', '"after all" hook', '"before each" hook', '"after each" hook', undefined].map(t => WdioJasmineTestFramework.reporterHookState(t)))
            .toEqual([TestFrameworkState.BEFORE_ALL, TestFrameworkState.AFTER_ALL, TestFrameworkState.NONE, TestFrameworkState.NONE, TestFrameworkState.NONE])
    })

    it('logs and continues when an observer throws', async () => {
        testHub.sendTestFrameworkEvent.mockRejectedValueOnce(new Error('send blew up'))
        const stats = testStats()
        reporterTestStart(stats, context())
        reporterTestEnd({ ...stats, state: 'passed', end: new Date() }, context())
        await drain()
        expect(dispatches.map(d => d.hook)).toEqual([HookState.POST])
        expect(framework.isIdle()).toBe(true)
    })

    // The class calls these TestHubModule methods directly; renaming or removing one must fail here.
    it('relies on TestHubModule handlers that exist', () => {
        for (const method of ['onBeforeTest', 'sendTestFrameworkEvent', 'sendLogCreatedEvent']) {
            expect(typeof (TestHubModule.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
        }
    })
})
