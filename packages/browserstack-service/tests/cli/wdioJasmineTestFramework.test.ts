import path from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import * as bstackLogger from '../../src/bstackLogger.js'
import WdioJasmineTestFramework from '../../src/cli/frameworks/wdioJasmineTestFramework.js'
import TestFramework from '../../src/cli/frameworks/testFramework.js'
import { TestFrameworkState } from '../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../src/cli/states/hookState.js'
import type TestFrameworkInstance from '../../src/cli/instances/testFrameworkInstance.js'

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
    let dispatches: Dispatch[]

    const drain = () => framework.trackEvent(TestFrameworkState.INIT_TEST, HookState.PRE, {})

    beforeEach(() => {
        process.env.BROWSERSTACK_OBSERVABILITY = 'true'
        framework = new WdioJasmineTestFramework(['WebdriverIO-jasmine'], { 'WebdriverIO-jasmine': '9.39.0' }, 'bin-session')
        dispatches = []
        vi.spyOn(framework, 'runHooks').mockImplementation(async (instance, state, hook, args) => {
            dispatches.push({ state, hook, data: snapshot(instance), args: args as Record<string, unknown> })
        })
    })

    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env.BROWSERSTACK_OBSERVABILITY
    })

    it('sends legacy identity for a spec, char-for-char with the CP0 TestRun', async () => {
        framework.onReporterTestStart(testStats() as any, context())
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
        framework.onReporterTestStart(testStats({ title: 'tagged @smoke', fullTitle: 'Outer @regression tagged @smoke' }) as any, context(['Outer @regression']))
        await drain()
        expect(dispatches[0].data.test_tags).toEqual(['@regression', '@smoke'])
    })

    it('finishes a passed spec on the same uuid with reporter timing and the result timestamp', async () => {
        const stats = testStats()
        framework.onReporterTestStart(stats as any, context())
        framework.onReporterTestEnd({ ...stats, state: 'passed', end: new Date('2026-09-25T15:34:16.645Z'), _duration: 4386 } as any, context())
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
        framework.onReporterTestStart(testStats({ uid: 'xit0', title: 'xit skipped test', fullTitle: 'Pending suite xit skipped test' }) as any, context(['Pending suite']))
        // @wdio/reporter replaces the TestStats object on test:pending; only the uid carries over
        framework.onReporterTestEnd(testStats({ uid: 'xit0', title: 'xit skipped test', fullTitle: 'Pending suite xit skipped test', state: 'skipped', end: new Date() }) as any, context(['Pending suite']))
        await drain()

        expect(dispatches).toHaveLength(2)
        expect(dispatches[1].data.test_result).toBe('skipped')
        expect(dispatches[1].data.test_duration).toBe(0)
        expect(dispatches[1].args.result).toMatchObject({ passed: false, skipped: true })
    })

    it('keeps jasmine\'s exact reason on a beforeAll-failed child', async () => {
        const error = { message: BEFORE_ALL_REASON, stack: '' }
        framework.onReporterTestStart(testStats({ uid: 'child0' }) as any, context())
        framework.onReporterTestEnd(testStats({ uid: 'child0', state: 'failed', error, end: new Date() }) as any, context())
        await drain()

        const finish = dispatches[1].data
        expect(finish.test_result).toBe('failed')
        expect(finish.test_failure_reason).toBe(BEFORE_ALL_REASON)
        expect(finish.test_failure_type).toBe('UnhandledError')
        expect(finish.test_failure).toEqual([{ backtrace: [BEFORE_ALL_REASON, ''] }])
    })

    it('maps an AssertionError message to failure_type AssertionError', async () => {
        framework.onReporterTestStart(testStats() as any, context())
        framework.onReporterTestEnd(testStats({ state: 'failed', error: { message: 'AssertionError: nope', stack: 'at x' } }) as any, context())
        await drain()
        expect(dispatches[1].data.test_failure_type).toBe('AssertionError')
    })

    it('gives overlapping specs distinct instances and closes each on its own uuid', async () => {
        framework.onReporterTestStart(testStats({ uid: 'a' }) as any, context())
        framework.onReporterTestStart(testStats({ uid: 'b', title: 'b', fullTitle: 'Nested outer b' }) as any, context())
        framework.onReporterTestEnd(testStats({ uid: 'a', state: 'passed', end: new Date() }) as any, context())
        framework.onReporterTestEnd(testStats({ uid: 'b', title: 'b', fullTitle: 'Nested outer b', state: 'passed', end: new Date() }) as any, context())
        await drain()

        const uuidOf = (i: number) => dispatches[i].data.test_uuid
        expect(uuidOf(0)).not.toBe(uuidOf(1))
        expect(uuidOf(2)).toBe(uuidOf(0))
        expect(uuidOf(3)).toBe(uuidOf(1))
        expect(dispatches[2].data.test_id).toBe('Nested outer outer passing test')
    })

    it('reports beforeAll/afterAll with legacy hook identity and no test linkage', async () => {
        const before = hookStats('"before all" hook')
        framework.onReporterHookStart(before as any, context())
        framework.onReporterHookEnd({ ...before, state: 'passed', end: new Date('2026-09-25T15:34:12.257Z'), _duration: 4087 } as any)
        const after = hookStats('"after all" hook')
        framework.onReporterHookStart(after as any, context(['Nested outer', 'Nested middle']))
        framework.onReporterHookEnd({ ...after, state: 'passed', end: new Date() } as any)
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
        expect('test_uuid' in dispatches[0].data).toBe(false)

        const afterStarted = (dispatches[2].data.test_hooks_started as Record<string, Record<string, unknown>[]>).AFTER_ALL[0]
        expect(afterStarted.hook_identifier).toBe('"after all" hook for Nested middle')
        expect(afterStarted.hook_scope).toBe('Nested outer - "after all" hook')
    })

    it('carries failure fields on a failed beforeAll', async () => {
        const before = hookStats('"before all" hook')
        framework.onReporterHookStart(before as any, context())
        framework.onReporterHookEnd({ ...before, state: 'failed', error: { message: 'boom', stack: 'Error: boom' }, end: new Date() } as any)
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
        framework.onReporterHookStart(hookStats('"before each" hook') as any, context())
        framework.onReporterHookStart(hookStats('"before all" hook') as any, context([]))
        await drain()
        expect(dispatches).toHaveLength(0)
    })

    it('suppresses hook and log families in an accessibility-only run, like the legacy Listener', async () => {
        delete process.env.BROWSERSTACK_OBSERVABILITY
        process.env.BROWSERSTACK_ACCESSIBILITY = 'true'
        try {
            const before = hookStats('"before all" hook')
            framework.onReporterHookStart(before as any, context())
            framework.onReporterHookEnd({ ...before, state: 'passed', end: new Date() } as any)
            framework.onReporterTestStart(testStats() as any, context())
            framework.onReporterLog({ level: 'INFO', message: 'hi', timestamp: 't', kind: 'TEST_LOG' })
            await drain()
            expect(dispatches.map(d => d.state)).toEqual([TestFrameworkState.TEST])
        } finally {
            delete process.env.BROWSERSTACK_ACCESSIBILITY
        }
    })

    it('absorbs service-hook states instead of re-dispatching them, leaving the spec tracked', async () => {
        framework.onReporterTestStart(testStats() as any, context())
        await framework.trackEvent(TestFrameworkState.INIT_TEST, HookState.PRE, { test: {} })
        const tracked = TestFramework.getTrackedInstance()
        expect(TestFramework.getState(tracked, 'test_uuid')).toBe(dispatches[0].data.test_uuid)

        await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { test: {} })
        await framework.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test: {}, result: {} })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test: {}, result: {} })
        expect(dispatches).toHaveLength(1)
    })

    it('attributes logs to an open all-hook, else to the last-started spec', async () => {
        framework.onReporterTestStart(testStats() as any, context())
        framework.onReporterLog({ level: 'INFO', message: 'in test', timestamp: 't1', kind: 'TEST_LOG' })
        const after = hookStats('"after all" hook')
        framework.onReporterHookStart(after as any, context())
        framework.onReporterLog({ level: 'INFO', message: 'in hook', timestamp: 't2', kind: 'TEST_LOG' })
        framework.onReporterHookEnd({ ...after, state: 'passed', end: new Date() } as any)
        framework.onReporterLog({ level: 'INFO', message: 'after hook', timestamp: 't3', kind: 'TEST_LOG' })
        await drain()

        const logs = dispatches.filter(d => d.state === TestFrameworkState.LOG)
        expect(logs).toHaveLength(3)
        const specUuid = dispatches[0].data.test_uuid
        expect(logs[0].data.test_uuid).toBe(specUuid)
        expect((logs[0].data.test_logs as Record<string, unknown>[]).at(-1)).not.toHaveProperty('hook_id')
        const hookLog = (logs[1].data.test_logs as Record<string, unknown>[]).at(-1)!
        expect(hookLog.hook_id).toBe((dispatches.find(d => d.state === TestFrameworkState.AFTER_ALL)!.data.test_hooks_started as Record<string, Record<string, unknown>[]>).AFTER_ALL[0].hook_id)
        expect(logs[2].data.test_uuid).toBe(specUuid)
    })

    it('keeps a screenshot entry\'s kind on the log path', async () => {
        framework.onReporterTestStart(testStats() as any, context())
        await framework.trackEvent(TestFrameworkState.LOG, HookState.POST, { logEntry: { kind: 'TEST_SCREENSHOT', message: 'b64', timestamp: 't', level: 'INFO' } })
        await drain()
        const log = dispatches.find(d => d.state === TestFrameworkState.LOG)!
        expect((log.data.test_logs as Record<string, unknown>[])[0].kind).toBe('TEST_SCREENSHOT')
    })

    it('is not idle until queued events are dispatched', async () => {
        framework.onReporterTestStart(testStats() as any, context())
        expect(WdioJasmineTestFramework.isIdle()).toBe(false)
        await drain()
        expect(WdioJasmineTestFramework.isIdle()).toBe(true)
    })

    it('logs and continues when an observer throws', async () => {
        vi.mocked(framework.runHooks).mockRejectedValueOnce(new Error('observer blew up'))
        const stats = testStats()
        framework.onReporterTestStart(stats as any, context())
        framework.onReporterTestEnd({ ...stats, state: 'passed', end: new Date() } as any, context())
        await drain()
        expect(dispatches.map(d => d.hook)).toEqual([HookState.POST])
        expect(WdioJasmineTestFramework.isIdle()).toBe(true)
    })
})
