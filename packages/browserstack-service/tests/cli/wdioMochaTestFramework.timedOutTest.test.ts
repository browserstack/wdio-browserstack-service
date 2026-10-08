import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { Frameworks } from '@wdio/types'
import * as bstackLogger from '../../src/bstackLogger.js'
import * as util from '../../src/util.js'

import WdioMochaTestFramework from '../../src/cli/frameworks/wdioMochaTestFramework.js'
import TestFramework from '../../src/cli/frameworks/testFramework.js'
import { TestFrameworkState } from '../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../src/cli/states/hookState.js'
import { TestFrameworkConstants } from '../../src/cli/frameworks/constants/testFrameworkConstants.js'
import type TestFrameworkInstance from '../../src/cli/instances/testFrameworkInstance.js'
import { BStackLogger as cliLogger } from '../../src/cli/cliLogger.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

/**
 * SDK-7843 — when a mocha test hits its timeout, mocha fails it (the reporter's `fail`) while its
 * body and wdio's afterTest are still pending, and moves on. These drive the real framework in
 * that order and record what the product modules (TestHubModule, AutomateModule) would observe.
 */
describe('WdioMochaTestFramework — a test finish is reported once, against its own test run', () => {
    let framework: WdioMochaTestFramework
    let finishes: string[]

    const runnable = () => ({ state: undefined as string | undefined, timedOut: false, duration: 0, timeout: () => 10000 })
    const makeTest = (title: string, extra: Record<string, unknown> = {}) =>
        ({ title, parent: 'Suite', file: '/spec.js', body: '', ctx: { test: runnable() }, ...extra }) as unknown as Frameworks.Test
    const failed = { passed: false, error: new Error('Timeout of 10000ms exceeded.'), duration: 10001, retries: { attempts: 0, limit: 0 }, exception: '', status: 'failed' } as Frameworks.TestResult
    const passed = { passed: true, duration: 40000, retries: { attempts: 0, limit: 0 }, exception: '', status: 'passed' } as Frameworks.TestResult

    const start = async (test: Frameworks.Test) => {
        await framework.trackEvent(TestFrameworkState.INIT_TEST, HookState.PRE, { test })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { test, suiteTitle: 'Suite' })
        return TestFramework.getState(TestFramework.getTrackedInstance(), TestFrameworkConstants.KEY_TEST_UUID) as string
    }
    const afterTest = async (test: Frameworks.Test, result: Frameworks.TestResult) => {
        await framework.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test, result })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test, result, suiteTitle: 'Suite' })
    }
    /** What the reporter sends from `fail`; wdio does not await it. */
    const reporterFail = (test: Frameworks.Test, result = failed) => {
        void framework.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test, result, fromMochaFail: true })
        void framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test, result, fromMochaFail: true })
    }

    beforeEach(() => {
        TestFramework.instances.clear()
        framework = new WdioMochaTestFramework(['WebdriverIO-mocha'], { 'WebdriverIO-mocha': '9' }, 'bin-session-id')
        finishes = []
        vi.spyOn(util, 'getMochaTestHierarchy').mockReturnValue([])
        vi.spyOn(util, 'getTestTags').mockReturnValue([])
        for (const level of ['info', 'debug', 'error'] as const) {
            vi.spyOn(cliLogger, level).mockImplementation(() => {})
        }
        // record the TEST/POST each product module would observe, with the test run it closes;
        // the modules' gRPC sends take real time, so an instant mock would hide a missing wait
        vi.spyOn(framework, 'runHooks').mockImplementation(async (instance: TestFrameworkInstance, state: State, hook: State, args: unknown) => {
            if (state === TestFrameworkState.TEST && hook === HookState.POST) {
                const { test, result } = args as { test: Frameworks.Test, result: Frameworks.TestResult }
                const uuid = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_UUID)
                await new Promise((resolve) => setTimeout(resolve, 20))
                finishes.push(`${test.title} ${uuid} passed=${result.passed}`)
            }
        })
    })

    afterEach(() => {
        vi.restoreAllMocks()
        TestFramework.instances.clear()
    })

    it('reports a timed-out test from mocha\'s `fail`, and drops its late afterTest', async () => {
        const test = makeTest('times out')
        const uuid = await start(test)

        reporterFail(test)
        await framework.settleTestFinishes()
        expect(finishes).toEqual([`times out ${uuid} passed=false`])

        // the body finished late and succeeded: wdio's afterTest says passed
        await afterTest(test, passed)
        expect(finishes).toEqual([`times out ${uuid} passed=false`])
    })

    it('reports a normal failure from afterTest, and drops the `fail` that follows it', async () => {
        const test = makeTest('fails')
        const uuid = await start(test)

        await afterTest(test, { ...failed, error: new Error('expected 1 to equal 2') })
        reporterFail(test)
        await framework.settleTestFinishes()

        expect(finishes).toEqual([`fails ${uuid} passed=false`])
    })

    it('closes a late afterTest against its own test run while the next test holds the slot', async () => {
        const first = makeTest('times out')
        const firstUuid = await start(first)
        const next = makeTest('next test')
        const nextUuid = await start(next)

        await afterTest(first, failed)

        expect(finishes).toEqual([`times out ${firstUuid} passed=false`])
        // the running test keeps its own test run
        expect(TestFramework.getState(TestFramework.getTrackedInstance(), TestFrameworkConstants.KEY_TEST_UUID)).toBe(nextUuid)
    })

    it('without a reporter, keeps mocha\'s failure when the late afterTest says passed', async () => {
        const test = makeTest('times out then succeeds')
        const uuid = await start(test)

        Object.assign(test.ctx!.test as object, { state: 'failed', timedOut: true, duration: 10001 })
        await afterTest(test, passed)

        expect(finishes).toEqual([`times out then succeeds ${uuid} passed=false`])
    })

    it('without a reporter, settle finishes a test mocha already failed, from its runnable', async () => {
        const timedOut = makeTest('times out unreported')
        const timedOutUuid = await start(timedOut)
        Object.assign(timedOut.ctx!.test as object, { state: 'failed', timedOut: true, duration: 10001 })
        const running = makeTest('still running')
        await start(running)
        const loadResult = vi.spyOn(framework, 'loadTestResult')

        await framework.settleTestFinishes()

        expect(finishes).toEqual([`times out unreported ${timedOutUuid} passed=false`])
        expect(loadResult).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            result: expect.objectContaining({ error: new Error('Timeout of 10000ms exceeded.') })
        }))
    })

    it('keeps each retried attempt on its own test run', async () => {
        const attempt0 = makeTest('flaky', { _currentRetry: 0 })
        const uuid0 = await start(attempt0)
        const attempt1 = makeTest('flaky', { _currentRetry: 1 })
        const uuid1 = await start(attempt1)

        // attempt 0's late afterTest, then attempt 1 times out too
        await afterTest(attempt0, failed)
        reporterFail(makeTest('flaky', { _currentRetry: 1 }))
        await framework.settleTestFinishes()

        expect(finishes).toEqual([`flaky ${uuid0} passed=false`, `flaky ${uuid1} passed=false`])
    })

    it('drops a `fail` for a test that never started (a hook), and still reports afterTest for one it never saw', async () => {
        await start(makeTest('runs'))

        reporterFail(makeTest('"before each" hook for runs'))
        await framework.settleTestFinishes()
        expect(finishes).toEqual([])

        await afterTest(makeTest('unseen'), passed)
        expect(finishes).toHaveLength(1)
    })
})
