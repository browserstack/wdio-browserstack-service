import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import * as bstackLogger from '../../src/bstackLogger.js'
import * as util from '../../src/util.js'
import WdioMochaTestFramework from '../../src/cli/frameworks/wdioMochaTestFramework.js'
import TestFramework from '../../src/cli/frameworks/testFramework.js'
import { TestFrameworkConstants } from '../../src/cli/frameworks/constants/testFrameworkConstants.js'
import { TestFrameworkState } from '../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../src/cli/states/hookState.js'
import { BStackLogger as cliLogger } from '../../src/cli/cliLogger.js'
import type { Frameworks } from '@wdio/types'
import type TestFrameworkInstance from '../../src/cli/instances/testFrameworkInstance.js'
import { drainSkipReports, enqueueReport } from '../../src/cli/skipReporter.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

// Deliberately NOT under process.cwd(), so an absolute value and a cwd-relative
// value cannot coincide and mask a regression.
const SPEC = '/Users/someone/projects/arenaclub/test/specs/smoke/homePage.test.ts'

describe('SDK-7233 — test_file_path must be the absolute spec path', () => {
    beforeEach(() => {
        vi.spyOn(TestFramework, 'getState').mockReturnValue('WebdriverIO-mocha')
        vi.spyOn(util, 'getUniqueIdentifier').mockReturnValue('Verify the homepage elements')
        vi.spyOn(util, 'getMochaTestHierarchy').mockReturnValue([])
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    // NB: not a default parameter — passing `undefined` explicitly must stay undefined.
    const getTestData = (...args: [file?: string | undefined]) =>
        getTestDataWith(args.length ? args[0] : SPEC)

    const getTestDataWith = (file: string | undefined) =>
        // @ts-expect-error — partial TestFrameworkInstance / Frameworks.Test are enough here
        WdioMochaTestFramework.prototype.getTestData.call(WdioMochaTestFramework.prototype, {}, {
            file,
            title: 'Verify the homepage elements',
            body: 'async () => {}',
        })

    it('sends the absolute path, so the binary can re-base it itself', async () => {
        // Previously this field was gated on a git root being resolvable; the
        // customer's project had none ("Unable to find a Git directory"), so it
        // went out as `undefined`, threw inside the binary, and dropped every
        // TestRunStarted/TestRunFinished event.
        const data = await getTestData()

        expect(data[TestFrameworkConstants.KEY_TEST_FILE_PATH]).toBe(SPEC)
        expect(path.isAbsolute(data[TestFrameworkConstants.KEY_TEST_FILE_PATH] as string)).toBe(true)
    })

    it('does not consult git metadata for the file path at all', async () => {
        // Re-basing is the binary's job (it holds pathProject and
        // versionControlInfo.root). The emitter must not pre-relativise, and no
        // longer pays for a git lookup per test.
        const git = vi.spyOn(util, 'getGitMetaData')

        await getTestData()

        expect(git).not.toHaveBeenCalled()
    })

    it('keeps test_location cwd-relative and distinct from test_file_path', async () => {
        const data = await getTestData()

        expect(data[TestFrameworkConstants.KEY_TEST_LOCATION]).toBe(path.relative(process.cwd(), SPEC))
        expect(data[TestFrameworkConstants.KEY_TEST_LOCATION]).not.toBe(
            data[TestFrameworkConstants.KEY_TEST_FILE_PATH],
        )
    })

    it('leaves both fields undefined when the spec filename is unknown', async () => {
        // Documented residual hole: a construct with no `test.file` still yields
        // undefined. Not reachable for normal Mocha specs, which always carry one.
        const data = await getTestData(undefined)

        expect(data[TestFrameworkConstants.KEY_TEST_FILE_PATH]).toBeUndefined()
        expect(data[TestFrameworkConstants.KEY_TEST_LOCATION]).toBeUndefined()
    })
})

describe('root-level mocha hooks fall back to the suite file, as on the non-CLI flow', () => {
    const ROOT_HOOK = { title: '"before each" hook: wrappedHook for "t1"' } as Frameworks.Test
    let framework: WdioMochaTestFramework

    beforeEach(() => {
        framework = Object.create(WdioMochaTestFramework.prototype)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const startHook = async (test: Frameworks.Test) => {
        const data = new Map<string, unknown>([
            [TestFrameworkConstants.KEY_HOOKS_STARTED, new Map()],
            [TestFrameworkConstants.KEY_HOOKS_FINISHED, new Map()],
            [TestFrameworkConstants.KEY_HOOK_ID, 'hook-1'],
        ])
        const instance = {
            getAllData: () => data,
            updateMultipleEntries: (entries: Record<string, unknown>) => Object.entries(entries).forEach(([k, v]) => data.set(k, v)),
        } as unknown as TestFrameworkInstance
        await framework.trackHookEvents(instance, TestFrameworkState.BEFORE_EACH, HookState.PRE, { test })
        return (data.get(TestFrameworkConstants.KEY_HOOKS_STARTED) as Map<string, Record<string, unknown>[]>).get('BEFORE_EACH')![0]
    }

    it('sends the current suite file for a hook mocha gives no file', async () => {
        // a beforeEach/afterEach declared outside any describe hangs off mocha's root suite, which
        // has no file; without a path the binary threw, dropped the hook events, and the test's
        // reference to the never-sent hook timed the build out
        framework.setSuiteFile(SPEC)

        const hook = await startHook(ROOT_HOOK)

        expect(hook[TestFrameworkConstants.KEY_HOOK_ID]).toBe('hook-1')
        expect(hook[TestFrameworkConstants.KEY_TEST_FILE_PATH]).toBe(SPEC)
        expect(hook[TestFrameworkConstants.KEY_TEST_LOCATION]).toBe(path.relative(process.cwd(), SPEC))
    })

    it('keeps the file mocha gives a hook declared inside a describe', async () => {
        framework.setSuiteFile('/Users/someone/projects/arenaclub/test/specs/other.test.ts')

        const hook = await startHook({ ...ROOT_HOOK, file: SPEC } as Frameworks.Test)

        expect(hook[TestFrameworkConstants.KEY_TEST_FILE_PATH]).toBe(SPEC)
    })

    it('applies the same fallback to test data', async () => {
        vi.spyOn(TestFramework, 'getState').mockReturnValue('WebdriverIO-mocha')
        vi.spyOn(util, 'getUniqueIdentifier').mockReturnValue('t1')
        vi.spyOn(util, 'getMochaTestHierarchy').mockReturnValue([])
        framework.setSuiteFile(SPEC)

        // @ts-expect-error — partial TestFrameworkInstance / Frameworks.Test are enough here
        const data = await framework.getTestData({}, { title: 't1', body: '' })

        expect(data[TestFrameworkConstants.KEY_TEST_FILE_PATH]).toBe(SPEC)
    })
})

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

describe('SDK-7843 — a log written before the first mocha hook is dropped quietly', () => {
    let framework: WdioMochaTestFramework
    let errorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        framework = new WdioMochaTestFramework(['WebdriverIO', 'mocha'], {}, 'bin-session-id')
        errorSpy = vi.spyOn(cliLogger, 'error').mockImplementation(() => {})
        vi.spyOn(cliLogger, 'info').mockImplementation(() => {})
        vi.spyOn(cliLogger, 'debug').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('does not log an ERROR for console output from wdio\'s `before` hook', async () => {
        // wdio's `before` runs before mocha's `before all`, so no instance is tracked yet.
        vi.spyOn(TestFramework, 'getTrackedInstance').mockReturnValue(null as any)
        const resolveSpy = vi.spyOn(framework, 'resolveInstance')

        await framework.trackEvent(TestFrameworkState.LOG, HookState.POST, {
            logEntry: { kind: 'TEST_LOG', message: '[SelfHealer] Installed', level: 'info', timestamp: new Date().toISOString() }
        })

        expect(errorSpy).not.toHaveBeenCalled()
        expect(resolveSpy).not.toHaveBeenCalled()
    })

    it('still resolves the instance for a log once a test or hook is tracked', async () => {
        vi.spyOn(TestFramework, 'getTrackedInstance').mockReturnValue({} as any)
        const resolveSpy = vi.spyOn(framework, 'resolveInstance').mockReturnValue(null)

        await framework.trackEvent(TestFrameworkState.LOG, HookState.POST, { logEntry: {} })

        expect(resolveSpy).toHaveBeenCalledOnce()
    })

    it('still reports a missing instance for non-log events', async () => {
        vi.spyOn(TestFramework, 'getTrackedInstance').mockReturnValue(null as any)

        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, {})

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('resolveInstance: unable to resolve/create instance'))
    })
})

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
        await framework.settleTestFinishes()

        expect(skippedTitles()).toEqual(['bail9 A3', 'bail9 B1'])
    })

    it('runs the cascade for a failure reported by mocha\'s `fail` from settle, not under the test\'s after-hooks (SDK-7843)', async () => {
        const { failing } = buildTree('bail10')
        await framework.trackEvent(TestFrameworkState.INIT_TEST, HookState.PRE, { test: failing })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { test: failing, suiteTitle: 'suite', bail: true })
        const failedUuid = TestFramework.getState(TestFramework.getTrackedInstance(), TestFrameworkConstants.KEY_TEST_UUID)
        trackEvent.mockClear()

        // the reporter's `fail`, which wdio does not await; mocha then runs the test's afterEach
        await framework.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test: failing, result: { passed: false }, fromMochaFail: true })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test: failing, result: { passed: false }, fromMochaFail: true })
        await framework.trackEvent(TestFrameworkState.AFTER_EACH, HookState.PRE, { test: failing })

        expect(skippedTitles()).toEqual([])
        expect(TestFramework.getState(TestFramework.getTrackedInstance(), TestFrameworkConstants.KEY_TEST_UUID)).toBe(failedUuid)

        await framework.settleTestFinishes()
        expect(skippedTitles()).toEqual(['bail10 A3', 'bail10 B1'])
    })

    it('runs the cascade from settle for a timed-out test\'s late afterTest, with no reporter (SDK-7843)', async () => {
        const { failing } = buildTree('bail11')
        await framework.trackEvent(TestFrameworkState.INIT_TEST, HookState.PRE, { test: failing })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { test: failing, suiteTitle: 'suite', bail: true })
        const failedUuid = TestFramework.getState(TestFramework.getTrackedInstance(), TestFrameworkConstants.KEY_TEST_UUID)
        // mocha timed the test out and moved on to its afterEach; wdio's afterTest arrives late
        Object.assign(failing.ctx.test, { state: 'failed', timedOut: true })
        trackEvent.mockClear()

        await framework.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test: failing, result: { passed: false } })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test: failing, result: { passed: false }, suiteTitle: 'suite' })
        await framework.trackEvent(TestFrameworkState.AFTER_EACH, HookState.PRE, { test: failing })

        expect(skippedTitles()).toEqual([])
        expect(TestFramework.getState(TestFramework.getTrackedInstance(), TestFrameworkConstants.KEY_TEST_UUID)).toBe(failedUuid)

        await framework.settleTestFinishes()
        expect(skippedTitles()).toEqual(['bail11 A3', 'bail11 B1'])
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
    /** What the reporter does in `fail`: pin the test, then queue its finish; wdio does not await it. */
    const reporterFail = (test: Frameworks.Test, result = failed) => {
        framework.pinFailedAttempt(test)
        void enqueueReport(async () => {
            await framework.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test, result, fromMochaFail: true })
            await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test, result, fromMochaFail: true })
        }, test.title)
    }
    /** service.after(): drain the report chain, then settle. */
    const settle = async () => {
        await drainSkipReports()
        await framework.settleTestFinishes()
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
        await settle()
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
        await settle()

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

        await settle()

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
        await settle()

        expect(finishes).toEqual([`flaky ${uuid0} passed=false`, `flaky ${uuid1} passed=false`])
    })

    // mocha retries a timed-out attempt without failing it: it emits `retry`, not `fail`, and
    // leaves the attempt's runnable `state` unset
    it('without a reporter, settle finishes a retried attempt whose body never returned', async () => {
        const fn = () => {}
        const attempt0 = makeTest('flaky', { fn, _currentRetry: 0 })
        const uuid0 = await start(attempt0)
        Object.assign(attempt0.ctx!.test as object, { timedOut: true, duration: 10001 })
        const attempt1 = makeTest('flaky', { fn, _currentRetry: 1 })
        const uuid1 = await start(attempt1)
        await afterTest({ ...attempt1 } as Frameworks.Test, passed)

        await settle()

        expect(finishes).toEqual([`flaky ${uuid1} passed=true`, `flaky ${uuid0} passed=false`])
    })

    it('keeps a retried attempt failed when its late afterTest says passed', async () => {
        const fn = () => {}
        const attempt0 = makeTest('flaky', { fn, _currentRetry: 0 })
        const uuid0 = await start(attempt0)
        Object.assign(attempt0.ctx!.test as object, { timedOut: true, duration: 10001 })
        await start(makeTest('flaky', { fn, _currentRetry: 1 }))

        await afterTest({ ...attempt0 } as Frameworks.Test, passed)

        expect(finishes).toEqual([`flaky ${uuid0} passed=false`])
    })

    it('closes a late afterTest by its own test when tests share one body', async () => {
        // for (const c of cases) it(c.name, sharedFn)
        const fn = () => {}
        const first = makeTest('case a', { fn })
        const firstUuid = await start(first)
        Object.assign(first.ctx!.test as object, { state: 'failed', timedOut: true, duration: 10001 })
        const second = makeTest('case b', { fn })
        const secondUuid = await start(second)

        await afterTest({ ...first } as Frameworks.Test, passed)
        await afterTest({ ...second } as Frameworks.Test, failed)

        expect(finishes).toEqual([`case a ${firstUuid} passed=false`, `case b ${secondUuid} passed=false`])
    })

    // `attemptKey` holds only the immediate parent's title, so these share `valid - works`:
    // describe('login', () => describe('valid', () => it('works'))) and the same under 'signup'
    it('reports a later test that shares an earlier finished test\'s key', async () => {
        const first = makeTest('works', { parent: 'valid' })
        const firstUuid = await start(first)
        await afterTest(first, passed)
        const second = makeTest('works', { parent: 'valid' })
        const secondUuid = await start(second)
        await afterTest(second, failed)

        expect(finishes).toEqual([`works ${firstUuid} passed=true`, `works ${secondUuid} passed=false`])
    })

    it('closes a late afterTest by the test\'s body when a same-named test has started since', async () => {
        // wdio hands beforeTest and afterTest separate copies of the mocha test; both carry its fn
        const first = makeTest('works', { parent: 'valid', fn: () => {} })
        const firstUuid = await start(first)
        reporterFail(makeTest('works', { parent: 'valid' }))
        await settle()
        const second = makeTest('works', { parent: 'valid', fn: () => {} })
        const secondUuid = await start(second)

        // the first test's body finishes late (and succeeds) while the second test is running; the
        // second then fails on its own
        await afterTest({ ...first } as Frameworks.Test, passed)
        await afterTest({ ...second } as Frameworks.Test, failed)

        expect(finishes).toEqual([`works ${firstUuid} passed=false`, `works ${secondUuid} passed=false`])
    })

    it('keeps the reporter\'s queued finish on the test it pinned, if a same-named test starts in between', async () => {
        const first = makeTest('works', { parent: 'valid', fn: () => {} })
        const firstUuid = await start(first)
        const failed1 = makeTest('works', { parent: 'valid' })
        // mocha's `fail`: the reporter pins the test now; its queued finish may run after mocha has
        // started the next test
        framework.pinFailedAttempt(failed1)
        const second = makeTest('works', { parent: 'valid', fn: () => {} })
        const secondUuid = await start(second)
        await framework.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test: failed1, result: failed, fromMochaFail: true })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test: failed1, result: failed, fromMochaFail: true })
        await afterTest({ ...second } as Frameworks.Test, passed)

        expect(finishes).toEqual([`works ${firstUuid} passed=false`, `works ${secondUuid} passed=true`])
    })

    it('drops a `fail` for a test that never started (a hook), and still reports afterTest for one it never saw', async () => {
        await start(makeTest('runs'))

        reporterFail(makeTest('"before each" hook for runs'))
        await settle()
        expect(finishes).toEqual([])

        await afterTest(makeTest('unseen'), passed)
        expect(finishes).toHaveLength(1)
    })
})
