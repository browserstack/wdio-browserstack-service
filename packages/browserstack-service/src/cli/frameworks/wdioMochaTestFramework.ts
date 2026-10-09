import { v4 as uuidv4 } from 'uuid'
import path from 'node:path'

import TestFramework from './testFramework.js'
import { TestFrameworkState } from '../states/testFrameworkState.js'
import { HookState } from '../states/hookState.js'
import TestFrameworkInstance from '../instances/testFrameworkInstance.js'
import { CLIUtils } from '../cliUtils.js'
import TrackedInstance from '../instances/trackedInstance.js'
import { TestFrameworkConstants } from './constants/testFrameworkConstants.js'
import { BStackLogger as logger } from '../cliLogger.js'
import type { Frameworks } from '@wdio/types'
import { getMochaTestHierarchy, getTestTags, getUniqueIdentifier, isUndefined, removeAnsiColors } from '../../util.js'
import { TEST_ANALYTICS_ID } from '../../constants.js'
import { reportSuiteSkipped } from '../skipReporter.js'

/**
 * File-path pair sent with every test/hook event.
 *
 * `test_file_path` must be the ABSOLUTE spec path: the binary re-bases it
 * itself, as `path.relative(session.pathProject, v)` for `file_name` and
 * `path.relative(versionControlInfo.root, v)` for `vc_filepath` (its local is
 * literally named `absoluteTestFilePath`). Sending a pre-relativised path made
 * both come out wrong; sending `undefined` — which is what happened whenever
 * there was no resolvable git root — threw inside the binary and dropped the
 * event entirely (SDK-7233).
 */
const resolveTestFilePaths = (filename: string | undefined) => ({
    [TestFrameworkConstants.KEY_TEST_FILE_PATH]: filename,
    [TestFrameworkConstants.KEY_TEST_LOCATION]: filename
        ? path.relative(process.cwd(), filename)
        : undefined,
})

/** mocha's live runnable of a test attempt; mocha sets `state` before it emits `fail`. */
interface MochaRunnable {
    state?: string
    timedOut?: boolean
    duration?: number
    timeout?: () => number
    currentRetry?: () => number
    retries?: () => number
    parent?: MochaSuite
}

interface MochaSuite {
    parent?: MochaSuite
    tests?: unknown[]
    suites?: unknown[]
}

/** A mocha test attempt that has started (TEST/PRE) and not finished yet (SDK-7843). */
interface TestAttempt {
    instance: TestFrameworkInstance
    test: Frameworks.Test
    suiteTitle?: unknown
    runnable?: MochaRunnable
    /** mocha's `bail`: a failure drops every test the spec has not reached yet. */
    bail?: boolean
    /** Who is reporting this attempt's finish: wdio's afterTest, or the reporter's `fail`. */
    finishingFrom?: 'afterTest' | 'fail'
    /** Its TEST/POST has been reported. */
    finished?: boolean
}

/** The failure mocha recorded on a runnable (it keeps no error object on it). */
const failureFromRunnable = (runnable: MochaRunnable): Frameworks.TestResult => {
    const ms = typeof runnable.timeout === 'function' ? runnable.timeout() : undefined
    const error = new Error(runnable.timedOut && ms ? `Timeout of ${ms}ms exceeded.` : 'Test failed before its afterTest ran.')
    return { passed: false, error, duration: runnable.duration ?? 0, retries: { attempts: 0, limit: 0 }, exception: error.message, status: 'failed' }
}

export default class WdioMochaTestFramework extends TestFramework {
    static KEY_HOOK_LAST_STARTED = 'test_hook_last_started'
    static KEY_HOOK_LAST_FINISHED = 'test_hook_last_finished'

    /**
     * SDK-7843: mocha test attempts that started and have not finished, keyed per attempt.
     *
     * wdio runs `afterTest` inside the test's own runnable, after the body. When a test hits
     * mocha's timeout, mocha fails it (and emits `fail` to reporters) while the body and its
     * `afterTest` are still pending; mocha then moves on, and with `bail` (or on the worker's last
     * test) wdio runs `after()` before that `afterTest`. So a test's finish can arrive from the
     * reporter's `fail`, from a late `afterTest` while another test holds the tracked-instance
     * slot, or not at all before the session status is marked. Each attempt keeps the instance it
     * started on, so its finish is reported against its own test run, once.
     */
    private openAttempts = new Set<TestAttempt>()
    /**
     * The latest attempt started under each `attemptKey`. The key holds only the immediate parent's
     * title, so two tests in a worker can share it; the later one's TEST/PRE replaces the entry.
     */
    private latestAttemptByKey = new Map<string, TestAttempt>()
    /**
     * Attempts by the test's body. wdio hands beforeTest and afterTest separate copies of the mocha
     * test (`{ ...context.test }`), but both carry its `fn`, so afterTest finds its own attempt even
     * when another test with the same key has started since.
     */
    private attemptsByFn = new WeakMap<object, Map<number, TestAttempt>>()
    /** The attempt a source's LOG_REPORT/POST resolved; its TEST/POST passes the same `test` object. */
    private resolvedFinishes = new WeakMap<object, TestAttempt>()
    private pendingFinishes = new Set<Promise<void>>()

    /** One attempt of a test: mocha retries a test as a new runnable with `_currentRetry` + 1. */
    static attemptKey(test: Frameworks.Test): string {
        const retry = (test as { _currentRetry?: number })._currentRetry
        const identifier = getUniqueIdentifier(test, 'mocha')
        return retry ? `${identifier} (retry ${retry})` : identifier
    }

    private static testBody(test: Frameworks.Test): object | undefined {
        const fn = (test as { fn?: unknown }).fn
        return typeof fn === 'function' ? fn : undefined
    }

    /**
   * Constructor for the TestFramework
   * @param {Array} testFrameworks - List of Test frameworks
   * @param {Map} testFrameworkVersions - Name of the Test frameworks
   * @param {string} binSessionId - BinSessionId
  */
    constructor(testFrameworks: string[], testFrameworkVersions: Record<string, string>, binSessionId: string) {
        super(testFrameworks, testFrameworkVersions, binSessionId)
    }

    /**
     * Find instance and track any state for the test framework
     * @param {TestFrameworkState} testFrameworkState
     * @param {HookState} hookState
     * @param {*} args
  */
    async trackEvent(testFrameworkState: State, hookState: State, args: Record<string, unknown> = {}) {
        if (args.fromMochaFail) {
            // the reporter's `fail` (SDK-7843): wdio does not await reporter callbacks, so keep the
            // send visible to settleTestFinishes()
            const work = this.trackTestEvent(testFrameworkState, hookState, args).catch((err: unknown) => {
                logger.debug(`trackEvent: reporting a failed test failed: ${err}`)
            })
            this.pendingFinishes.add(work)
            work.finally(() => this.pendingFinishes.delete(work))
            return work
        }
        await this.trackTestEvent(testFrameworkState, hookState, args)
    }

    private async trackTestEvent(testFrameworkState: State, hookState: State, args: Record<string, unknown>) {
        logger.info(`trackEvent: testFrameworkState=${testFrameworkState} hookState=${hookState}`)
        // before any await: the reporter's `fail` must resolve to the attempt mocha just failed,
        // before mocha starts the next test (it defers that with setImmediate)
        const attempt = this.resolveTestAttempt(testFrameworkState, hookState, args)
        await super.trackEvent(testFrameworkState, hookState, args)

        // Console output from wdio's `before` hook (after the service has patched console)
        // arrives before mocha's first hook, so there is no test or hook to attach it to yet and
        // resolveInstance cannot create one for LOG. The classic path drops such a log silently; do the same instead of
        // printing an ERROR on every worker (SDK-7843).
        if (testFrameworkState === TestFrameworkState.LOG && !TestFramework.getTrackedInstance()) {
            logger.debug(`trackEvent: no test or hook started yet, dropping log for testFrameworkState=${testFrameworkState} hookState=${hookState}`)
            return
        }

        if (attempt === null) {
            return
        }
        let instance: TestFrameworkInstance | null
        if (attempt) {
            instance = attempt.instance
            this.updateInstanceState(instance, testFrameworkState, hookState)
        } else {
            instance = this.resolveInstance(testFrameworkState, hookState, args)
        }
        if (instance === null) {
            logger.error(`trackEvent: instance not found for testFrameworkState=${testFrameworkState} hookState=${hookState}`)
            return
        }
        if (testFrameworkState === TestFrameworkState.TEST && hookState === HookState.PRE && args.test) {
            this.openTestAttempt(instance, args)
        }

        try {
            // matchHookRegex expects the short state name (e.g. AFTER_EACH); `toString()` yields
            // the fully-qualified `TestFrameworkState.AFTER_EACH`, which never matches `^(BEFORE_|AFTER_)`.
            // Without this, KEY_HOOK_ID is never set, hook_run.uuid ends up empty, and the backend
            // (BigQuery) drops the hook events despite them being sent.
            if (CLIUtils.matchHookRegex(testFrameworkState.toString().split('.')[1]) && hookState === HookState.PRE) {
                instance.updateMultipleEntries({
                    [TestFrameworkConstants.KEY_HOOK_ID]: uuidv4(),
                })
            }

            if (!TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_ID) && hookState === HookState.PRE && testFrameworkState === TestFrameworkState.TEST) {
                const test = args.test as Frameworks.Test
                const testData = await this.getTestData(instance, test)
                logger.info(`trackEvent: instanceData=${JSON.stringify(Object.fromEntries(instance.getAllData()))}`)
                instance.updateMultipleEntries(testData)
            }

            if (testFrameworkState === TestFrameworkState.TEST) {
                if (hookState === HookState.PRE) {
                    instance.updateMultipleEntries({
                        [TestFrameworkConstants.KEY_TEST_STARTED_AT]: new Date().toISOString(),
                    })
                } else if (hookState === HookState.POST) {
                    instance.updateMultipleEntries({
                        [TestFrameworkConstants.KEY_TEST_ENDED_AT]: new Date().toISOString(),
                    })
                }
            } else if (testFrameworkState === TestFrameworkState.LOG) {
                const logEntry = args.logEntry as Record<string, unknown>
                logEntry.uuid = TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOK_ID)
                this.loadLogEntries(instance, testFrameworkState, hookState, logEntry)
            } else if (testFrameworkState === TestFrameworkState.LOG_REPORT && hookState === HookState.POST) {
                logger.info('trackEvent: load test results')
                this.loadTestResult(instance, args)
            }

            // Only real hook states accumulate into test_hooks_started/finished. trackEvent runs
            // for every state (TEST/INIT_TEST/LOG/...); without this gate those push pseudo-hook
            // entries which — now that the Map serializer actually emits them — get flat-mapped into
            // TestRunFinished.hooks (duplicating the last hook id / adding '') and accumulate in
            // test_hooks_started forever (never popped).
            if (CLIUtils.matchHookRegex(testFrameworkState.toString().split('.')[1])) {
                await this.trackHookEvents(instance, testFrameworkState, hookState, args)
            }
            logger.debug(`trackEvent: tracked instance data=${JSON.stringify(Object.fromEntries(instance.getAllData()))}`)
        } catch (error) {
            logger.error(`trackEvent: Error in tracking events: ${error} hookState=${hookState} testFrameworkState=${testFrameworkState}`)
        }
        args.instance = instance
        await this.runHooks(instance, testFrameworkState, hookState, args)
        if (attempt && testFrameworkState === TestFrameworkState.TEST) {
            await this.reportBailSkippedTests(attempt, args.result as Frameworks.TestResult)
        }
    }

    /**
     * Whether this failure will be retried, in which case mocha has not dropped anything yet and
     * the tests after it are still going to run.
     *
     * `results.retries` only tracks wdio's spec-file retries — `@wdio/utils` builds it as
     * `{ attempts: 0, limit: repeatTest }` and `@wdio/mocha-framework` never feeds `mochaOpts.retries`
     * into it, so under mocha-level retries it stays `{0, 0}` and tells us nothing. Read mocha's own
     * runnable state for that case, otherwise the cascade fires on the first attempt and reports
     * tests as skipped that the retry then actually runs. The runnable is the one captured at
     * TEST/PRE: once mocha fails a timed-out test it moves on, and the suite's shared
     * `ctx.test` then points at a hook, which inherits the suite's `retries` (SDK-7843).
     */
    private hasRetryPending(runnable: MochaRunnable | undefined, results: Frameworks.TestResult): boolean {
        if (typeof runnable?.currentRetry === 'function' && typeof runnable.retries === 'function') {
            if (runnable.currentRetry() < runnable.retries()) {
                return true
            }
        }
        return Boolean(results.retries && results.retries.attempts < results.retries.limit)
    }

    /**
     * mocha's `bail` aborts the run on the first failure, so every test the spec had not reached
     * yet is dropped without emitting any event and never appears on the dashboard. Report them
     * as skipped — same cascade the failed-hook path uses, from the spec's root suite so sibling
     * describes are covered too (bail kills the whole spec, not just the failing describe).
     *
     * The root can span more than one file when specs are grouped — `MochaAdapter` adds every spec
     * it is handed to one mocha instance. Cascading across them is still correct: bail aborts that
     * whole runner, so those tests do not run either.
     *
     * Runs as part of the failed test's finish, so it lands before the session status is marked
     * and the last test finish is flushed, also when that finish came from mocha's `fail` (SDK-7843).
     */
    private async reportBailSkippedTests(attempt: TestAttempt, results: Frameworks.TestResult | undefined) {
        if (!attempt.bail || !results || results.passed || results.skipped) {
            return
        }
        try {
            // inside the boundary: hasRetryPending reaches into mocha's own runnable, which this
            // SDK does not own
            if (this.hasRetryPending(attempt.runnable, results)) {
                return
            }
            let suite = attempt.runnable?.parent
            if (!suite) {
                return
            }
            while (suite.parent) {
                suite = suite.parent
            }
            await reportSuiteSkipped(this, suite)
        } catch (err) {
            logger.debug(`Failed reporting bail-skipped tests: ${err}`)
        }
    }

    /** TEST/PRE: this attempt's finish is owed from here on, against this instance. */
    private openTestAttempt(instance: TestFrameworkInstance, args: Record<string, unknown>) {
        const test = args.test as Frameworks.Test
        const attempt: TestAttempt = {
            instance,
            test,
            suiteTitle: args.suiteTitle,
            runnable: test.ctx?.test as MochaRunnable | undefined,
            bail: args.bail === true
        }
        this.openAttempts.add(attempt)
        this.latestAttemptByKey.set(WdioMochaTestFramework.attemptKey(test), attempt)
        const body = WdioMochaTestFramework.testBody(test)
        if (body) {
            const byRetry = this.attemptsByFn.get(body) ?? new Map<number, TestAttempt>()
            byRetry.set((test as { _currentRetry?: number })._currentRetry ?? 0, attempt)
            this.attemptsByFn.set(body, byRetry)
        }
    }

    /**
     * The attempt a finish belongs to. wdio's afterTest carries the test's body, which identifies
     * it exactly. The reporter's `fail` has only the title and parent: it is resolved (before any
     * await, see trackTestEvent) to the latest attempt with that key, which is the one mocha just
     * failed, and pinned so the same source's TEST/POST cannot land on a later same-named test.
     */
    private findTestAttempt(test: Frameworks.Test): TestAttempt | undefined {
        const resolved = this.resolvedFinishes.get(test)
        if (resolved) {
            return resolved
        }
        const body = WdioMochaTestFramework.testBody(test)
        if (body) {
            return this.attemptsByFn.get(body)?.get((test as { _currentRetry?: number })._currentRetry ?? 0)
        }
        return this.latestAttemptByKey.get(WdioMochaTestFramework.attemptKey(test))
    }

    /**
     * LOG_REPORT/POST and TEST/POST of a mocha test: the attempt to report against. Returns
     * undefined for any other event, and for a test this framework never saw start (resolved as
     * before); null to drop the event, when the attempt is already finished or another source is
     * finishing it.
     */
    private resolveTestAttempt(testFrameworkState: State, hookState: State, args: Record<string, unknown>): TestAttempt | null | undefined {
        const isFinish = hookState === HookState.POST && (testFrameworkState === TestFrameworkState.TEST || testFrameworkState === TestFrameworkState.LOG_REPORT)
        if (!isFinish || !args.test) {
            return undefined
        }
        const test = args.test as Frameworks.Test
        const source = args.fromMochaFail ? 'fail' : 'afterTest'
        const attempt = this.findTestAttempt(test)
        if (!attempt) {
            // the reporter's `fail` for a hook, or for a test that never started
            return source === 'fail' ? null : undefined
        }
        if (attempt.finished || (attempt.finishingFrom && attempt.finishingFrom !== source)) {
            logger.debug(`trackEvent: '${WdioMochaTestFramework.attemptKey(test)}' was already reported, dropping ${testFrameworkState} ${hookState} from ${source}`)
            return null
        }
        attempt.finishingFrom = source
        this.resolvedFinishes.set(test, attempt)
        args.suiteTitle ??= attempt.suiteTitle
        // a timed-out test whose body finished late: wdio's result says only whether the body
        // threw, not that mocha already failed it
        if (attempt.runnable?.state === 'failed' && (args.result as Frameworks.TestResult | undefined)?.passed) {
            args.result = failureFromRunnable(attempt.runnable)
        }
        if (testFrameworkState === TestFrameworkState.TEST) {
            attempt.finished = true
            this.openAttempts.delete(attempt)
        }
        return attempt
    }

    /**
     * Before the session status is marked and the last test finish is flushed: finish every attempt
     * mocha already failed that nothing reported (no reporter is registered when Test Reporting,
     * Accessibility and Percy are all off), then wait for every finish the reporter started.
     */
    async settleTestFinishes(): Promise<void> {
        for (const attempt of [...this.openAttempts]) {
            if (attempt.runnable?.state === 'failed' && !attempt.finishingFrom) {
                const result = failureFromRunnable(attempt.runnable)
                this.resolvedFinishes.set(attempt.test, attempt)
                await this.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test: attempt.test, result, fromMochaFail: true })
                await this.trackEvent(TestFrameworkState.TEST, HookState.POST, { test: attempt.test, result, suiteTitle: attempt.suiteTitle, fromMochaFail: true })
            }
        }
        while (this.pendingFinishes.size > 0) {
            await Promise.all([...this.pendingFinishes])
        }
    }

    /**
   * Resolve instance for the test framework
   * @param {TestFrameworkState} testFrameworkState
   * @param {HookState} hookState
   * @param {*} args
   * @returns {TestFrameworkInstance}
   */
    resolveInstance(testFrameworkState: State, hookState: State, args: Record<string, unknown> = {}): TestFrameworkInstance|null {
        logger.info(`resolveInstance: resolving instance for testFrameworkState=${testFrameworkState} hookState=${hookState}`)
        const shortState = testFrameworkState.toString().split('.')[1]
        const isHook = CLIUtils.matchHookRegex(shortState)
        let instance = TestFramework.getTrackedInstance()

        // Whether the current tracked instance has already run its test body.
        const hasRunTest = !!(instance && TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_ID))

        // New-test boundary (ports Junit5Framework.resolveInstance): the previous method was a
        // test / after-hook (POST) and the current is a before-hook / init (PRE) — the next test
        // is starting. At entry, getCurrentTestState()/getCurrentHookState() still hold the PREVIOUS
        // method's state (updateInstanceState has not run yet).
        const prevState = instance ? instance.getCurrentTestState().toString() : ''
        const prevWasTerminal = instance ? (instance.getCurrentTestState() === TestFrameworkState.TEST || prevState.includes('AFTER')) : false
        const isNewTestBoundary = instance ? (prevWasTerminal && instance.getCurrentHookState() === HookState.POST && hookState === HookState.PRE) : false

        if (testFrameworkState === TestFrameworkState.NONE) {
            this.trackWdioMochaInstance(testFrameworkState, args)
        } else if (testFrameworkState === TestFrameworkState.INIT_TEST) {
            // WDIO fires `before each` BEFORE `beforeTest` (INIT_TEST). Reuse the instance a
            // preceding before-hook already opened for this same upcoming test; only start a new
            // one if the current instance has already run a test (or none exists).
            if (!instance || hasRunTest) {
                this.trackWdioMochaInstance(testFrameworkState, args)
            }
        } else if (isHook && hookState === HookState.PRE) {
            // Suite-level (`before all`) and the first `before each` fire before any INIT_TEST, so
            // no instance exists yet — create one. Also, a BEFORE hook right after a completed test
            // (new-test boundary) starts a new test. The boundary restriction must be limited to
            // BEFORE hooks: `after each`/`after all` also fire at a POST->PRE boundary (afterTest
            // emits TEST POST just before `after each`), but they belong to the just-finished test.
            // Creating a fresh (uuid-less) instance for them would drop test_run_id and orphan the
            // hook from TestRunFinished.hooks — so let after-hooks reuse the finished test's instance.
            if (!instance || (isNewTestBoundary && shortState.startsWith('BEFORE_'))) {
                this.trackWdioMochaInstance(testFrameworkState, args)
            }
        }

        instance = TestFramework.getTrackedInstance()
        if (!instance) {
            logger.error(`resolveInstance: unable to resolve/create instance for testFrameworkState=${testFrameworkState} hookState=${hookState}`)
            return null
        }
        this.updateInstanceState(instance, testFrameworkState, hookState)

        return instance
    }

    /**
   * Track WebdriverIO instance
   * @param {TestFrameworkState} testFrameworkState
   * @param {*} args
   */
    trackWdioMochaInstance(testFrameworkState: State, args: Record<string, unknown>) {
        const target = CLIUtils.getCurrentInstanceName()
        const trackedContext = TrackedInstance.createContext(target)
        let instance = null
        logger.info(`trackWdioMochaInstance: created instance for target=${target}, state=${testFrameworkState}, args=${args}`)

        instance = new TestFrameworkInstance(
            trackedContext,
            this.getTestFrameworks(),
            this.getTestFrameworksVersions(),
            testFrameworkState,
            HookState.NONE
        )

        const frameworkName = this.getTestFrameworks()[0]

        const instanceEntries = {
            [TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME]: frameworkName,
            [TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION]: this.getTestFrameworksVersions()[frameworkName],
            [TestFrameworkConstants.KEY_TEST_LOGS]: [],
            [TestFrameworkConstants.KEY_HOOKS_FINISHED]: new Map(),
            [TestFrameworkConstants.KEY_HOOKS_STARTED]: new Map(),
            [TestFrameworkConstants.KEY_TEST_UUID]: uuidv4(),
            [TestFrameworkConstants.KEY_TEST_RESULT]: TestFrameworkConstants.DEFAULT_TEST_RESULT,
            // TODO[CLI]: Add customRerunParam
            // [TestFrameworkConstants.KEY_TEST_RERUN_NAME]:
        }

        // Setting test uuid in env variable for A11y and App a11y scans
        process.env[TEST_ANALYTICS_ID] = instanceEntries[TestFrameworkConstants.KEY_TEST_UUID] as string

        instance.updateMultipleEntries(instanceEntries)

        TestFramework.setTrackedInstance(trackedContext, instance)
        logger.info(`trackWdioMochaInstance: saved instance contextId=${trackedContext.getId()} target=${target}`)
    }

    async getTestData(instance: TestFrameworkInstance, test: Frameworks.Test) {
        const framework = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME)
        const fullTitle = getUniqueIdentifier(test, framework)
        const filename = test.file // || this._suiteFile
        const scopes = getMochaTestHierarchy(test)

        const testData: Record<string, unknown> = {
            [TestFrameworkConstants.KEY_TEST_ID]: getUniqueIdentifier(test, framework),
            [TestFrameworkConstants.KEY_TEST_NAME]: test.title || test.description,
            [TestFrameworkConstants.KEY_TEST_CODE]: test.body || '',
            ...resolveTestFilePaths(filename),
            [TestFrameworkConstants.KEY_TEST_SCOPE]: fullTitle,
            [TestFrameworkConstants.KEY_TEST_SCOPES]: scopes,
            [TestFrameworkConstants.KEY_TEST_TAGS]: getTestTags(test, scopes),
        }

        return testData
    }

    loadTestResult(instance: TestFrameworkInstance, args: Record<string, unknown>) {
        const results = args.result as Frameworks.TestResult
        const { error, passed, skipped } = results
        let result = 'passed'
        let failure: Array<unknown>|null = null
        let failureReason: string|null = null
        let failureType: string|null = null
        if (!passed) {
            if (skipped) {
                result = 'skipped'
            } else {
                result = (error && error.message && error.message.includes('sync skip; aborting execution')) ? 'ignore' : 'failed'
            }
            if (error && result !== 'skipped') {
                failure = [{ backtrace: [removeAnsiColors(error.message), removeAnsiColors(error.stack || '')] }] // add all errors here
                failureReason = removeAnsiColors(error.message)
                failureType = isUndefined(error.message) ? null : error.message.toString().match(/AssertionError/) ? 'AssertionError' : 'UnhandledError' //verify if this is working
            }
        }

        instance.updateMultipleEntries({
            [TestFrameworkConstants.KEY_TEST_RESULT]: result,
            [TestFrameworkConstants.KEY_TEST_FAILURE]: failure,
            [TestFrameworkConstants.KEY_TEST_FAILURE_REASON]: failureReason,
            [TestFrameworkConstants.KEY_TEST_FAILURE_TYPE]: failureType,
        })
    }

    /**
     * Load log entries into the test framework instance.
     * @param instance TestFrameworkInstance
     * @param testFrameworkState TestFrameworkState
     * @param hookState HookState
     * @param args Additional arguments (level, message, etc.)
     */
    loadLogEntries(instance: TestFrameworkInstance, testFrameworkState: State, hookState: State, logEntry: Record<string, unknown>) {
        const logRecord: Record<string, unknown> = {}
        const { level, message, timestamp, kind } = logEntry

        if (CLIUtils.matchHookRegex(instance.getCurrentTestState().toString().split('.')[1])) {
            logRecord[TestFrameworkConstants.KEY_HOOK_ID] = TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOK_ID)
        }
        // Console logs carry no kind and stay KIND_LOG; a producer that sets one (a screenshot,
        // say) keeps it, or the entry would reach Observability labelled as a console log.
        logRecord.kind = kind ?? TestFrameworkConstants.KIND_LOG
        logRecord.message = Buffer.from(message as string)
        logRecord.level = level
        logRecord.timestamp = timestamp

        // Attach to the suitable hook
        const lastActiveHook = WdioMochaTestFramework.lastActiveHook(instance, WdioMochaTestFramework.KEY_HOOK_LAST_STARTED)
        if (lastActiveHook) {
            const hookLogs = lastActiveHook[TestFrameworkConstants.KEY_HOOK_LOGS] as unknown[]
            hookLogs.push(logRecord)
            logger.debug(`hooks after update logs ${TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOKS_STARTED)} ${TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOKS_FINISHED)}`)
            return
        }

        // Attach to the test instance
        const entries = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_LOGS) as unknown[]
        entries.push(logRecord)
        instance.updateMultipleEntries({
            [TestFrameworkConstants.KEY_TEST_LOGS]: entries,
        })
    }

    /**
     * Get the last active hook for the given instance and hook key.
     * @param instance TestFrameworkInstance
     * @param lastHookKey string
     * @returns Record<string, unknown> | null
     */
    static lastActiveHook(instance: TestFrameworkInstance, lastHookKey: string): Record<string, unknown> | null {
        const hookStore = lastHookKey === WdioMochaTestFramework.KEY_HOOK_LAST_FINISHED
            ? TestFrameworkConstants.KEY_HOOKS_FINISHED
            : TestFrameworkConstants.KEY_HOOKS_STARTED

        const lastActive = TestFramework.getState(instance, lastHookKey) as string | null
        let hooksMap: Record<string, unknown> | null = null

        if (lastActive) {
            hooksMap = TestFramework.getState(instance, hookStore) as Record<string, unknown> | null
        }

        if (hooksMap && lastActive && hooksMap[lastActive]) {
            const lastHooks = hooksMap[lastActive] as unknown[]
            if (lastHooks.length > 0) {
                return lastHooks[lastHooks.length - 1] as Record<string, unknown>
            }
        }
        return null
    }

    /**
     * Clear logs for a specific hook.
     * @param instance TestFrameworkInstance
     * @param lastHookKey string
     */
    static clearHookLogs(instance: TestFrameworkInstance, lastHookKey: string) {
        const hook = this.lastActiveHook(instance, lastHookKey)
        if (hook) {
            hook[TestFrameworkConstants.KEY_HOOK_LOGS] = []
        }
    }

    /**
     * Clear all logs for the given instance, test framework state, and hook state.
     * @param instance TestFrameworkInstance
     * @param testFrameworkState TestFrameworkState
     * @param hookState HookState
     */
    static clearLogs(instance: TestFrameworkInstance, testFrameworkState: State, hookState: State) {
        const lastHookKey = hookState === HookState.PRE
            ? WdioMochaTestFramework.KEY_HOOK_LAST_STARTED
            : WdioMochaTestFramework.KEY_HOOK_LAST_FINISHED

        WdioMochaTestFramework.clearHookLogs(instance, lastHookKey)

        instance.updateMultipleEntries({
            [TestFrameworkConstants.KEY_TEST_LOGS]: [],
        })
    }

    /**
     * Get all log entries for the given instance, test framework state, and hook state.
     * @param instance TestFrameworkInstance
     * @param testFrameworkState TestFrameworkState
     * @param hookState HookState
     * @returns unknown[]
     */
    static getLogEntries(instance: TestFrameworkInstance, testFrameworkState: State, hookState: State): unknown[] {
        const lastHookKey = hookState === HookState.PRE
            ? WdioMochaTestFramework.KEY_HOOK_LAST_STARTED
            : WdioMochaTestFramework.KEY_HOOK_LAST_FINISHED

        const hook = WdioMochaTestFramework.lastActiveHook(instance, lastHookKey)
        const entries = hook ? (hook[TestFrameworkConstants.KEY_HOOK_LOGS] as unknown[]) : []
        const testEntries = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_LOGS) as unknown[]

        return [...entries, ...testEntries]
    }

    /**
     * Track hook events for the test framework.
     * @param instance TestFrameworkInstance
     * @param testFrameworkState TestFrameworkState
     * @param hookState HookState
     * @param args Additional arguments (e.g., test result, test method)
     */
    async trackHookEvents(
        instance: TestFrameworkInstance,
        testFrameworkState: State,
        hookState: State,
        args: Record<string, unknown>
    ) {
        const testResult = args.result as Frameworks.TestResult
        const test = args.test as Frameworks.Test
        // Key hooks by the short state name (e.g. AFTER_EACH), matching how the binary looks them
        // up via `event.test_hooks_started[request.testFrameworkState]`. `toString()` yields the
        // fully-qualified `TestFrameworkState.AFTER_EACH`, which would never match.
        const key = testFrameworkState.toString().split('.')[1]

        const hooksStarted = TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOKS_STARTED) as Map<string, unknown[]>
        if (!hooksStarted.has(key)) {
            hooksStarted.set(key, [])
        }

        const hooksFinished = TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOKS_FINISHED) as Map<string, unknown[]>
        if (!hooksFinished.has(key)) {
            hooksFinished.set(key, [])
        }

        const updates: Record<string, unknown> = {
            [TestFrameworkConstants.KEY_HOOKS_STARTED]: hooksStarted,
            [TestFrameworkConstants.KEY_HOOKS_FINISHED]: hooksFinished,
        }

        if (hookState === HookState.PRE) {
            const filename = test.file
            const hook: Record<string, unknown> = {
                key,
                [TestFrameworkConstants.KEY_HOOK_ID]: TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOK_ID) || '',
                [TestFrameworkConstants.KEY_HOOK_RESULT]: TestFrameworkConstants.DEFAULT_HOOK_RESULT,
                [TestFrameworkConstants.KEY_EVENT_STARTED_AT]: new Date().toISOString(),
                [TestFrameworkConstants.KEY_HOOK_LOGS]: [],
                [TestFrameworkConstants.KEY_HOOK_NAME]: test.title || test.description,
                ...resolveTestFilePaths(filename),
            }
            hooksStarted.get(key)?.push(hook)
            updates[WdioMochaTestFramework.KEY_HOOK_LAST_STARTED] = key
            logger.info(`Hook Started in PRE key = ${key} & hook = ${JSON.stringify(hook)}`)
        } else if (hookState === HookState.POST) {
            const hooksList = hooksStarted.get(key) || []
            logger.info(`Hook List in Post ${JSON.stringify(hooksList)}`)

            if (hooksList.length > 0) {
                const hook = hooksList.pop() as Record<string, unknown>
                // Frameworks.TestResult carries `passed`/`skipped`, not `status` — reading `.status`
                // left hook_result at 'pending', which the binary coerces to 'passed' for any
                // finished hook, so failed before-hooks showed green builds while CI exited 1.
                // A this.skip() hook arrives as {passed: false, skipped: true} — a deliberate
                // skip, not a failure.
                // guard the sync-skip error shape too (wdio v8 delivers this.skip() hooks without
                // a `skipped` flag; harmless on v9, keeps the lines aligned)
                const skippedHook = testResult?.skipped || !!testResult?.error?.message?.includes('sync skip; aborting execution')
                const result = testResult
                    ? (testResult.passed ? 'passed' : (skippedHook ? 'skipped' : 'failed'))
                    : TestFrameworkConstants.DEFAULT_HOOK_RESULT
                if (result !== TestFrameworkConstants.DEFAULT_HOOK_RESULT) {
                    hook[TestFrameworkConstants.KEY_HOOK_RESULT] = result
                }
                hook[TestFrameworkConstants.KEY_EVENT_ENDED_AT] = new Date().toISOString()
                hooksFinished.get(key)?.push(hook)
                updates[WdioMochaTestFramework.KEY_HOOK_LAST_FINISHED] = key
            }
        }

        instance.updateMultipleEntries(updates)
        logger.info(`trackHookEvents: hook state=${key}.${hookState}, hooks started=${JSON.stringify(hooksStarted)}, hooks finished=${JSON.stringify(hooksFinished)}`)
    }
}
