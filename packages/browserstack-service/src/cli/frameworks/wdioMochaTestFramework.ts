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
import { getGitMetaData, getMochaTestHierarchy, getTestTags, getUniqueIdentifier, isUndefined, removeAnsiColors } from '../../util.js'
import { TEST_ANALYTICS_ID } from '../../constants.js'

/** mocha's live runnable of a test attempt; mocha sets `state` before it emits `fail`. */
interface MochaRunnable {
    state?: string
    timedOut?: boolean
    duration?: number
    timeout?: () => number
}

/** A mocha test attempt that has started (TEST/PRE) and not finished yet (SDK-7843). */
interface TestAttempt {
    instance: TestFrameworkInstance
    test: Frameworks.Test
    suiteTitle?: unknown
    runnable?: MochaRunnable
    /** Who is reporting this attempt's finish: wdio's afterTest, or the reporter's `fail`. */
    finishingFrom?: 'afterTest' | 'fail'
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
    private openAttempts = new Map<string, TestAttempt>()
    private finishedAttempts = new Set<string>()
    private pendingFinishes = new Set<Promise<void>>()

    /** One attempt of a test: mocha retries a test as a new runnable with `_currentRetry` + 1. */
    static attemptKey(test: Frameworks.Test): string {
        const retry = (test as { _currentRetry?: number })._currentRetry
        const identifier = getUniqueIdentifier(test, 'mocha')
        return retry ? `${identifier} (retry ${retry})` : identifier
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
        await super.trackEvent(testFrameworkState, hookState, args)

        // Console output from wdio's `before` hook (after the service has patched console)
        // arrives before mocha's first hook, so there is no test or hook to attach it to yet and
        // resolveInstance cannot create one for LOG. The classic path drops such a log silently; do the same instead of
        // printing an ERROR on every worker (SDK-7843).
        if (testFrameworkState === TestFrameworkState.LOG && !TestFramework.getTrackedInstance()) {
            logger.debug(`trackEvent: no test or hook started yet, dropping log for testFrameworkState=${testFrameworkState} hookState=${hookState}`)
            return
        }

        const attempt = this.resolveTestAttempt(testFrameworkState, hookState, args)
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
            // HOOK_REGEX is anchored (^BEFORE_|^AFTER_) — match the short state name; the
            // fully-qualified `TestFrameworkState.BEFORE_ALL` never matches, so hook ids were
            // never minted and hooks reached TRA with an empty uuid (dropped at ingestion).
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

            await this.trackHookEvents(instance, testFrameworkState, hookState, args)
            logger.debug(`trackEvent: tracked instance data=${JSON.stringify(Object.fromEntries(instance.getAllData()))}`)
        } catch (error) {
            logger.error(`trackEvent: Error in tracking events: ${error} hookState=${hookState} testFrameworkState=${testFrameworkState}`)
        }
        args.instance = instance
        await this.runHooks(instance, testFrameworkState, hookState, args)
    }

    /** TEST/PRE: this attempt's finish is owed from here on, against this instance. */
    private openTestAttempt(instance: TestFrameworkInstance, args: Record<string, unknown>) {
        const test = args.test as Frameworks.Test
        this.openAttempts.set(WdioMochaTestFramework.attemptKey(test), {
            instance,
            test,
            suiteTitle: args.suiteTitle,
            runnable: test.ctx?.test as MochaRunnable | undefined
        })
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
        const key = WdioMochaTestFramework.attemptKey(args.test as Frameworks.Test)
        const source = args.fromMochaFail ? 'fail' : 'afterTest'
        const attempt = this.openAttempts.get(key)
        if (this.finishedAttempts.has(key) || (attempt?.finishingFrom && attempt.finishingFrom !== source)) {
            logger.debug(`trackEvent: '${key}' was already reported, dropping ${testFrameworkState} ${hookState} from ${source}`)
            return null
        }
        if (!attempt) {
            // the reporter's `fail` for a hook, or for a test that never started
            return source === 'fail' ? null : undefined
        }
        attempt.finishingFrom = source
        // a timed-out test whose body finished late: wdio's result says only whether the body
        // threw, not that mocha already failed it
        if (attempt.runnable?.state === 'failed' && (args.result as Frameworks.TestResult | undefined)?.passed) {
            args.result = failureFromRunnable(attempt.runnable)
        }
        if (testFrameworkState === TestFrameworkState.TEST) {
            this.openAttempts.delete(key)
            this.finishedAttempts.add(key)
        }
        return attempt
    }

    /**
     * Before the session status is marked and the last test finish is flushed: finish every attempt
     * mocha already failed that nothing reported (no reporter is registered when Test Reporting,
     * Accessibility and Percy are all off), then wait for every finish the reporter started.
     */
    async settleTestFinishes(): Promise<void> {
        for (const attempt of [...this.openAttempts.values()]) {
            if (attempt.runnable?.state === 'failed' && !attempt.finishingFrom) {
                const result = failureFromRunnable(attempt.runnable)
                await this.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test: attempt.test, result, fromMochaFail: true })
                await this.trackEvent(TestFrameworkState.TEST, HookState.POST, { test: attempt.test, result, fromMochaFail: true })
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
        const gitConfig = await getGitMetaData()
        const filename = test.file // || this._suiteFile

        const scopes = getMochaTestHierarchy(test)

        const testData: Record<string, unknown> = {
            [TestFrameworkConstants.KEY_TEST_ID]: getUniqueIdentifier(test, framework),
            [TestFrameworkConstants.KEY_TEST_NAME]: test.title || test.description,
            [TestFrameworkConstants.KEY_TEST_CODE]: test.body || '',
            [TestFrameworkConstants.KEY_TEST_FILE_PATH]: (gitConfig?.root && filename) ? path.relative(gitConfig.root, filename) : undefined,
            [TestFrameworkConstants.KEY_TEST_LOCATION]: filename ? path.relative(process.cwd(), filename) : undefined,
            [TestFrameworkConstants.KEY_TEST_SCOPE]: fullTitle,
            [TestFrameworkConstants.KEY_TEST_SCOPES]: scopes,
            [TestFrameworkConstants.KEY_TEST_TAGS]: getTestTags(test, scopes),
        }

        return testData
    }

    loadTestResult(instance: TestFrameworkInstance, args: Record<string, unknown>) {
        const results = args.result as Frameworks.TestResult & { skipped?: boolean }
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

        if (CLIUtils.matchHookRegex(instance.getCurrentTestState().toString())) {
            logRecord[TestFrameworkConstants.KEY_HOOK_ID] = TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOK_ID)
        }
        // SDK-6277: honor the incoming log kind (e.g. TEST_SCREENSHOT) so screenshots route correctly
        // on the binary side; default to TEST_LOG (KIND_LOG) for ordinary stdout/console logs.
        logRecord.kind = (kind as string) ?? TestFrameworkConstants.KIND_LOG
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
        // Key hooks by the short state name (e.g. BEFORE_ALL), matching how the binary looks
        // them up via `event.test_hooks_started[request.testFrameworkState]`. `toString()` yields
        // the fully-qualified `TestFrameworkState.BEFORE_ALL`, which never matches — hook finishes
        // were dropped with "unable to determine hook-finished".
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
            const gitConfig = await getGitMetaData()
            const filename = test.file
            const hook: Record<string, unknown> = {
                key,
                [TestFrameworkConstants.KEY_HOOK_ID]: TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOK_ID) || '',
                [TestFrameworkConstants.KEY_HOOK_RESULT]: TestFrameworkConstants.DEFAULT_HOOK_RESULT,
                [TestFrameworkConstants.KEY_EVENT_STARTED_AT]: new Date().toISOString(),
                [TestFrameworkConstants.KEY_HOOK_LOGS]: [],
                [TestFrameworkConstants.KEY_HOOK_NAME]: test.title || test.description,
                [TestFrameworkConstants.KEY_TEST_FILE_PATH]: (gitConfig?.root && filename) ? path.relative(gitConfig.root, filename) : undefined,
                [TestFrameworkConstants.KEY_TEST_LOCATION]: filename ? path.relative(process.cwd(), filename) : undefined,
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
                // wdio v8's TestResult type does not declare `skipped`, but the runtime carries it
                // wdio v8 does not set `skipped` for a this.skip() before-all — it surfaces as an
                // error carrying mocha's sync-skip marker; treat both shapes as a deliberate skip
                const skippedHook = (testResult as Frameworks.TestResult & { skipped?: boolean })?.skipped
                    || !!testResult?.error?.message?.includes('sync skip; aborting execution')
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
