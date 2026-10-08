import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as bstackLogger from '../../src/bstackLogger.js'
import * as util from '../../src/util.js'

import WdioMochaTestFramework from '../../src/cli/frameworks/wdioMochaTestFramework.js'
import TestFramework from '../../src/cli/frameworks/testFramework.js'
import { TestFrameworkState } from '../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../src/cli/states/hookState.js'
import { BStackLogger as cliLogger } from '../../src/cli/cliLogger.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

describe('mocha bail skip cascade (SDK-7063), run by the CLI framework with the test\'s finish', () => {
    let framework: WdioMochaTestFramework
    let trackEvent: ReturnType<typeof vi.spyOn>

    // reportSkippedTest de-dupes on `${parent} - ${title}` in a module-scope Set that outlives
    // each test, so every case here needs its own titles.
    const buildTree = (tag: string) => {
        const root: any = { title: '', tests: [], suites: [], parent: undefined }
        const suiteA: any = { title: `${tag} Suite A`, tests: [], suites: [], parent: root }
        const suiteB: any = { title: `${tag} Suite B`, tests: [], suites: [], parent: root }
        root.suites.push(suiteA, suiteB)

        const ran: any = { title: `${tag} A1`, state: 'passed', parent: suiteA, file: '/spec/a.js' }
        const failing: any = { title: `${tag} A2`, state: 'failed', parent: suiteA, file: '/spec/a.js' }
        const dropped: any = { title: `${tag} A3`, parent: suiteA, file: '/spec/a.js' }
        suiteA.tests.push(ran, failing, dropped)
        // sibling top-level describe — only reachable because the cascade walks up to root
        suiteB.tests.push({ title: `${tag} B1`, parent: suiteB, file: '/spec/a.js' })

        failing.ctx = { test: { parent: suiteA } }
        return { failing, root }
    }

    /** beforeTest's events, then afterTest's, as the service sends them. */
    const runTest = async (failing: any, results: Record<string, unknown>, bail = true) => {
        await framework.trackEvent(TestFrameworkState.INIT_TEST, HookState.PRE, { test: failing })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { test: failing, suiteTitle: 'suite', bail })
        trackEvent.mockClear()
        await framework.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test: failing, result: results })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test: failing, result: results, suiteTitle: 'suite' })
    }

    // WHICH tests got reported, not just how many events fired — a cascade that swept the wrong
    // tests still produces the same call count. Pairs with the count assertions, which catch the
    // opposite failure (a test emitted twice).
    const skippedTitles = () => [...new Set(
        trackEvent.mock.calls
            .filter(([, , payload]: any[]) => payload?.result?.skipped === true)
            .map(([, , payload]: any[]) => payload.test.title as string)
    )].sort()

    beforeEach(() => {
        TestFramework.instances.clear()
        framework = new WdioMochaTestFramework(['WebdriverIO-mocha'], { 'WebdriverIO-mocha': '9' }, 'bin-session-id')
        vi.spyOn(util, 'getMochaTestHierarchy').mockReturnValue([])
        vi.spyOn(util, 'getTestTags').mockReturnValue([])
        for (const level of ['info', 'debug', 'error'] as const) {
            vi.spyOn(cliLogger, level).mockImplementation(() => {})
        }
        vi.spyOn(framework, 'runHooks').mockResolvedValue(undefined)
        trackEvent = vi.spyOn(framework, 'trackEvent')
    })

    afterEach(() => {
        vi.restoreAllMocks()
        TestFramework.instances.clear()
    })

    it('reports un-run tests across sibling describes when mocha bail is on', async () => {
        const { failing } = buildTree('bail1')
        await runTest(failing, { passed: false })

        // 2 events close the failing test (LOG_REPORT/POST + TEST/POST), then 4 per skipped test.
        // A3 (same describe) and B1 (SIBLING describe) => 2 skipped => 8.
        expect(trackEvent).toHaveBeenCalledTimes(2 + 8)
        // exactly the un-run tests: A1 already passed and A2 is the failure being reported,
        // so sweeping either of them in would be a defect the count alone cannot see
        expect(skippedTitles()).toEqual(['bail1 A3', 'bail1 B1'])
    })

    it('does not cascade without mocha bail', async () => {
        const { failing } = buildTree('bail2')
        await runTest(failing, { passed: false }, false)

        expect(trackEvent).toHaveBeenCalledTimes(2)
        expect(skippedTitles()).toEqual([])
    })

    it('does not cascade while a wdio spec-file retry is still queued', async () => {
        const { failing } = buildTree('bail3')
        await runTest(failing, { passed: false, retries: { attempts: 0, limit: 2 } })

        expect(trackEvent).toHaveBeenCalledTimes(2)
        expect(skippedTitles()).toEqual([])
    })

    it('does not cascade while a MOCHA-level retry is still queued', async () => {
        // wdio's `results.retries` only tracks spec-file retries — @wdio/mocha-framework never
        // feeds mochaOpts.retries into it, so it reads {0,0} here and cannot be relied on.
        // Without reading mocha's own runnable state the cascade fires on attempt 1 and reports
        // tests as skipped that the retry then actually runs.
        const { failing } = buildTree('bail5')
        failing.ctx.test.currentRetry = () => 0
        failing.ctx.test.retries = () => 1
        await runTest(failing, { passed: false, retries: { attempts: 0, limit: 0 } })

        expect(trackEvent).toHaveBeenCalledTimes(2)
        expect(skippedTitles()).toEqual([])
    })

    it('cascades once the final mocha retry has been used', async () => {
        const { failing } = buildTree('bail6')
        failing.ctx.test.currentRetry = () => 1
        failing.ctx.test.retries = () => 1
        await runTest(failing, { passed: false, retries: { attempts: 0, limit: 0 } })

        expect(trackEvent).toHaveBeenCalledTimes(2 + 8)
        expect(skippedTitles()).toEqual(['bail6 A3', 'bail6 B1'])
    })

    it('cascades from the runnable the test started on, not the hook mocha moved on to (SDK-7843)', async () => {
        // the final attempt under `retries: 1` times out; mocha moves on to an afterEach hook,
        // which inherits the suite's retries, before the finish is reported
        const { failing } = buildTree('bail9')
        failing.ctx.test.currentRetry = () => 1
        failing.ctx.test.retries = () => 1
        await framework.trackEvent(TestFrameworkState.INIT_TEST, HookState.PRE, { test: failing })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { test: failing, suiteTitle: 'suite', bail: true })
        failing.ctx.test = { parent: failing.parent, currentRetry: () => 0, retries: () => 1 }
        trackEvent.mockClear()

        await framework.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test: failing, result: { passed: false }, fromMochaFail: true })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test: failing, result: { passed: false }, fromMochaFail: true })

        expect(skippedTitles()).toEqual(['bail9 A3', 'bail9 B1'])
    })

    it('does not cascade when the test passed', async () => {
        const { failing } = buildTree('bail4')
        await runTest(failing, { passed: true })

        expect(trackEvent).toHaveBeenCalledTimes(2)
        expect(skippedTitles()).toEqual([])
    })

    it('does not cascade when the test was itself skipped', async () => {
        // a skipped test does not abort the spec, and the pre-existing skip paths already
        // report it — cascading here would double-report the rest of the suite
        const { failing } = buildTree('bail7')
        await runTest(failing, { passed: false, skipped: true })

        // A2 is the test being reported and its own result is legitimately `skipped`; what must
        // NOT appear is A3/B1, which the cascade would have added.
        expect(trackEvent).toHaveBeenCalledTimes(2)
        expect(skippedTitles()).toEqual(['bail7 A2'])
    })

    it('never throws out of the finish when mocha state is hostile', async () => {
        // afterTest is awaited by wdio; anything escaping this cascade would surface as a
        // framework-level error in the user's run
        const { failing } = buildTree('bail8')
        failing.ctx.test.currentRetry = () => { throw new Error('mocha exploded') }
        failing.ctx.test.retries = () => 1

        await runTest(failing, { passed: false })
        expect(skippedTitles()).toEqual([])
    })
})
