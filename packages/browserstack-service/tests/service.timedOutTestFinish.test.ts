import path from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { Frameworks } from '@wdio/types'

import BrowserstackService from '../src/service.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import TestFramework from '../src/cli/frameworks/testFramework.js'
import { TestFrameworkState } from '../src/cli/states/testFrameworkState.js'
import { AutomationFrameworkState } from '../src/cli/states/automationFrameworkState.js'
import { HookState } from '../src/cli/states/hookState.js'
import { cliTestAttemptKey, finishCliTestOnFailure, resetCliTestFinishers } from '../src/cli/earlyTestFinish.js'
import * as bstackLogger from '../src/bstackLogger.js'

vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))
vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

/**
 * SDK-7843 — with a mocha timeout, mocha fails the test (and tells reporters) while its body and
 * wdio's afterTest are still pending; with `bail`, wdio then runs after() before that afterTest.
 * These drive the service hooks in exactly that order.
 */
describe('service — a timed-out mocha test is finished when mocha fails it (SDK-7843)', () => {
    let events: string[]
    let testTrackEvent: ReturnType<typeof vi.fn>
    let flush: ReturnType<typeof vi.fn>
    // the single tracked-instance slot the CLI reads the test uuid from
    let slotUuid: string | undefined
    let minted: number

    const makeTest = (title: string, extra: Record<string, unknown> = {}) =>
        ({ title, parent: 'Suite', ctx: { test: {} }, ...extra }) as unknown as Frameworks.Test
    const timedOutTest = makeTest('times out')
    const failed = { passed: false, error: new Error('Timeout of 300000ms exceeded.'), duration: 300000, retries: { attempts: 0, limit: 0 }, exception: '', status: 'failed' } as Frameworks.TestResult

    const makeService = () => new BrowserstackService(
        { testObservability: false } as never,
        [] as never,
        { user: 'foo', key: 'bar', framework: 'mocha', mochaOpts: { bail: true } } as never
    )

    beforeEach(() => {
        resetCliTestFinishers()
        events = []
        slotUuid = undefined
        minted = 0
        // gRPC sends take real time; an instant mock would hide after() not waiting for the finish
        testTrackEvent = vi.fn().mockImplementation(async (state: unknown, hook: unknown, args: { result?: Frameworks.TestResult, test?: Frameworks.Test }) => {
            if (state === TestFrameworkState.INIT_TEST) {
                slotUuid = `uuid-${++minted}`
                return
            }
            // the CLI reads the uuid when the event is handled, before the send
            const uuid = slotUuid
            await new Promise((resolve) => setTimeout(resolve, 30))
            const result = args?.result ? ` ${args.result.skipped ? 'skipped' : `passed=${args.result.passed}`}` : ''
            events.push(`${String(state)}/${String(hook)}${result}${state === TestFrameworkState.TEST && hook === HookState.POST ? ` ${args.test?.title} ${uuid}` : ''}`)
        })
        flush = vi.fn().mockImplementation(async () => {
            events.push('flushPendingTestFinishEvent')
        })
        vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({
            isRunning: () => true,
            getTestFramework: () => ({ trackEvent: testTrackEvent }),
            getAutomationFramework: () => ({
                trackEvent: vi.fn().mockImplementation(async (state: unknown, hook: unknown) => {
                    events.push(`${String(state)}/${String(hook)}`)
                })
            }),
            modules: { TestHubModule: { flushPendingTestFinishEvent: flush } }
        } as never)
        vi.spyOn(TestFramework, 'getTrackedInstance').mockReturnValue({} as never)
        vi.spyOn(TestFramework, 'getState').mockImplementation(() => slotUuid as never)
        vi.spyOn(TestFramework, 'setState').mockImplementation((_instance: unknown, _key: unknown, value: unknown) => {
            slotUuid = value as string
        })
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const testPosts = () => events.filter((e) => e.startsWith(`${TestFrameworkState.TEST}/${HookState.POST}`))

    it('reports the failure, then marks the session, then ignores the late afterTest', async () => {
        const service = makeService()
        await service.beforeTest(timedOutTest)
        events.length = 0

        // mocha's `fail` reaches the reporter first...
        expect(finishCliTestOnFailure('Suite - times out', failed)).toBe(true)
        // ...then wdio runs after() before the timed-out test's afterTest
        await service.after(1)
        // ...and only then the late afterTest
        await service.afterTest(timedOutTest, undefined as never, { ...failed })

        const testPost = events.indexOf(`${TestFrameworkState.TEST}/${HookState.POST} passed=false times out uuid-1`)
        const flushAt = events.indexOf('flushPendingTestFinishEvent')
        const sessionStatusAt = events.indexOf(`${AutomationFrameworkState.EXECUTE}/${HookState.POST}`)
        expect(testPost).toBeGreaterThanOrEqual(0)
        // the failure is recorded before the deferred-finish flush and before EXECUTE/POST,
        // which is where AutomateModule marks the session status
        expect(testPost).toBeLessThan(flushAt)
        expect(flushAt).toBeLessThan(sessionStatusAt)
        // reported once: the late afterTest added no second LOG_REPORT/TEST POST
        expect(testPosts()).toHaveLength(1)
        expect(events.filter((e) => e.startsWith(`${TestFrameworkState.LOG_REPORT}/${HookState.POST}`))).toHaveLength(1)
    })

    it('without a reporter, after() still finishes a test mocha failed, from mocha\'s runnable', async () => {
        const service = makeService()
        const runnable = { state: undefined as string | undefined, timedOut: false, timeout: () => 10000, duration: 0 }
        const test = makeTest('times out unreported', { ctx: { test: runnable } })
        await service.beforeTest(test)
        events.length = 0

        // mocha's timeout: Runner#fail sets the state; no reporter hears the `fail`
        Object.assign(runnable, { state: 'failed', timedOut: true, duration: 10001 })
        await service.after(1)
        await service.afterTest(test, undefined as never, { ...failed })

        const testPost = events.indexOf(`${TestFrameworkState.TEST}/${HookState.POST} passed=false times out unreported uuid-1`)
        expect(testPost).toBeGreaterThanOrEqual(0)
        expect(testPost).toBeLessThan(events.indexOf('flushPendingTestFinishEvent'))
        expect(testPost).toBeLessThan(events.indexOf(`${AutomationFrameworkState.EXECUTE}/${HookState.POST}`))
        expect(testPosts()).toHaveLength(1)
    })

    it('runs the bail cascade from the reporter path, before the flush', async () => {
        const service = makeService()
        const root: { title: string, tests: unknown[], suites: unknown[], parent?: unknown } = { title: '', tests: [], suites: [] }
        const suite = { title: 'Suite', parent: root, tests: [] as unknown[], suites: [] }
        root.suites.push(suite)
        suite.tests.push({ title: 'never reached', parent: suite, state: undefined, file: '/spec.js', body: '' })
        const test = makeTest('times out with bail', { ctx: { test: { parent: suite } } })
        await service.beforeTest(test)
        events.length = 0

        expect(finishCliTestOnFailure('Suite - times out with bail', failed)).toBe(true)
        await service.after(1)

        const failedAt = events.indexOf(`${TestFrameworkState.TEST}/${HookState.POST} passed=false times out with bail uuid-1`)
        const skippedAt = events.findIndex((e) => e.includes('skipped never reached'))
        const flushAt = events.indexOf('flushPendingTestFinishEvent')
        expect(failedAt).toBeGreaterThanOrEqual(0)
        expect(skippedAt).toBeGreaterThan(failedAt)
        expect(skippedAt).toBeLessThan(flushAt)
    })

    it('closes the timed-out test with its own uuid even when the next test took the slot meanwhile', async () => {
        const service = makeService()
        const next = makeTest('next test')
        await service.beforeTest(timedOutTest)
        events.length = 0

        // the reporter starts the finish; mocha (no bail) moves on to the next test during its LOG_REPORT send
        expect(finishCliTestOnFailure('Suite - times out', failed)).toBe(true)
        await service.beforeTest(next)
        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(testPosts()).toEqual([`${TestFrameworkState.TEST}/${HookState.POST} passed=false times out uuid-1`])
        // and the slot is handed back to the test now running
        expect(slotUuid).toBe('uuid-2')
    })

    it('lets a retried attempt\'s late afterTest close that attempt, not the next one', async () => {
        const service = makeService()
        const attempt0 = makeTest('flaky', { _currentRetry: 0 })
        const attempt1 = makeTest('flaky', { _currentRetry: 1 })
        await service.beforeTest(attempt0)
        // attempt 0 timed out and is retried (mocha emits `retry`, not `fail`); attempt 1 starts
        await service.beforeTest(attempt1)
        events.length = 0

        // attempt 0's late afterTest
        await service.afterTest(attempt0, undefined as never, { ...failed })
        // attempt 1 times out too: the reporter can still report it
        expect(finishCliTestOnFailure(cliTestAttemptKey('Suite - flaky', 1), failed)).toBe(true)
        await service.after(1)

        expect(testPosts()).toEqual([
            `${TestFrameworkState.TEST}/${HookState.POST} passed=false flaky uuid-1`,
            `${TestFrameworkState.TEST}/${HookState.POST} passed=false flaky uuid-2`
        ])
    })

    it('still reports a normal failure from afterTest, and the reporter then does nothing', async () => {
        const service = makeService()
        await service.beforeTest(timedOutTest)
        events.length = 0

        await service.afterTest(timedOutTest, undefined as never, { ...failed })
        expect(finishCliTestOnFailure('Suite - times out', failed)).toBe(false)

        expect(testPosts()).toHaveLength(1)
    })

    it('reports afterTest for a test it never saw start, as before', async () => {
        const service = makeService()

        await service.afterTest(makeTest('unseen'), undefined as never, { passed: true } as Frameworks.TestResult)

        expect(testPosts()).toHaveLength(1)
    })
})
