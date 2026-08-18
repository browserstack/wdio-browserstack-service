import util from 'node:util'
import BaseModule from './baseModule.js'
import { BStackLogger } from '../cliLogger.js'
import TestFramework from '../frameworks/testFramework.js'
import { TestFrameworkState } from '../states/testFrameworkState.js'
import { HookState } from '../states/hookState.js'
import { CLIUtils } from '../cliUtils.js'
import { TestFrameworkConstants } from '../frameworks/constants/testFrameworkConstants.js'
import { GrpcClient } from '../grpcClient.js'
import type TestFrameworkInstance from '../instances/testFrameworkInstance.js'
// eslint-disable-next-line camelcase
import type { LogCreatedEventRequest, LogCreatedEventRequest_LogEntry, TestFrameworkEventRequest, TestSessionEventRequest, AutomationSession } from '../../grpc/index.js'
import type { Frameworks } from '@wdio/types'
import WdioMochaTestFramework from '../frameworks/wdioMochaTestFramework.js'
import type AutomationFrameworkInstance from '../instances/automationFrameworkInstance.js'
import AutomationFramework from '../frameworks/automationFramework.js'
import { AutomationFrameworkConstants } from '../frameworks/constants/automationFrameworkConstants.js'
import { isLoadTestingSession, getLtsSessionId } from '../../util.js'

/**
 * TestHub Module for BrowserStack
 */
export default class TestHubModule extends BaseModule {

    logger = BStackLogger
    testhubConfig: unknown
    name: string
    static MODULE_NAME = 'TestHubModule'

    /**
     * Mocha-only: the TEST/POST (TestRunFinished) send deferred past the after-each hook
     * window. WDIO fires `afterTest` (which triggers TEST/POST) BEFORE the user's
     * `afterEach` hooks run, so custom tags set in `afterEach` would otherwise miss the
     * event. The payload (`eventJson`) is serialized from the instance's live data map at
     * SEND time, so deferring the send picks up those late merges; uuid / started_at /
     * ended_at are already stamped in the data and do not drift. The stashed
     * `args.instance` is the finished test's OWN object — INIT_TEST replaces the tracked
     * slot with a fresh instance for the next test — so it stays valid across tests.
     * Flushed at the next test's first event (INIT_TEST / TEST PRE) or, for the worker's
     * last test, from service.after() via flushPendingTestFinishEvent().
     */
    private pendingTestFinish: { args: Record<string, unknown> } | null = null

    /**
     * Create a new TestHubModule
     */
    constructor(testhubConfig: unknown) {
        super()
        this.name = 'TestHubModule'
        this.testhubConfig = testhubConfig

        TestFramework.registerObserver(TestFrameworkState.TEST, HookState.PRE, this.onBeforeTest.bind(this))

        Object.values(TestFrameworkState).forEach(state => {
            Object.values(HookState).forEach(hook => {
                TestFramework.registerObserver(state, hook, this.onAllTestEvents.bind(this))
            })
        })
    }

    /**
     * Get the module name
     * @returns {string} The module name
     */
    getModuleName() {
        return TestHubModule.MODULE_NAME
    }

    onBeforeTest(args: Record<string, unknown>) {
        this.logger.debug('onBeforeTest: Called after test hook from cli configured module!!!')
        const autoInstance = AutomationFramework.getTrackedInstance() as AutomationFrameworkInstance
        const instances = [autoInstance]
        args.autoInstance = instances
        this.sendTestSessionEvent(args)
    }

    onAllTestEvents(args: Record<string, unknown>) {
        this.logger.debug('onAllTestEvents: Called after all test events from cli configured module!!!')
        const instance = args.instance as TestFrameworkInstance
        const testState = instance.getCurrentTestState()
        const hookState = instance.getCurrentHookState()
        const keyTestDeferred = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_DEFERRED)

        // A NEW test is starting (INIT_TEST minted a fresh instance) — the previous test's
        // after-each hook window is definitively over, so flush its deferred finish first
        // (payload build is synchronous, so gRPC send order is preserved).
        if (this.pendingTestFinish && (testState === TestFrameworkState.INIT_TEST || (testState === TestFrameworkState.TEST && hookState === HookState.PRE))) {
            this.flushPendingTestFinishEvent()
        }
        if (testState === TestFrameworkState.LOG) {
            this.logger.debug(`onAllTestEvents: TestFrameworkState.LOG - ${testState}`)
            const logEntries = WdioMochaTestFramework.getLogEntries(instance, testState, hookState)
            if (logEntries && logEntries.length > 0) {
                args.logEntries = logEntries
                this.sendLogCreatedEvent(args)
                WdioMochaTestFramework.clearLogs(instance, testState, hookState)
                // Handle LOG state if needed
            }
        } else if (
            testState === TestFrameworkState.TEST &&
            hookState === HookState.POST &&
            !TestFramework.hasState(instance, TestFrameworkConstants.KEY_TEST_RESULT_AT)
        ) {
            this.logger.info('onAllTestEvents: dropping due to lack of results')
            TestFramework.setState(instance, TestFrameworkConstants.KEY_TEST_DEFERRED, true)
        } else if (
            keyTestDeferred &&
            testState === TestFrameworkState.LOG_REPORT &&
            hookState === HookState.POST &&
            TestFramework.hasState(instance, TestFrameworkConstants.KEY_TEST_RESULT_AT)
        ) {
            // Create a modified args object with updated test framework state
            instance.setCurrentTestState(TestFrameworkState.TEST)
            this.onAllTestEvents(args)
        }

        if (testState === TestFrameworkState.TEST || CLIUtils.matchHookRegex(testState.toString().split('.')[1])) {
            const frameworkName = String(TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME) || '')
            if (testState === TestFrameworkState.TEST && hookState === HookState.POST && frameworkName.toLowerCase().includes('mocha')) {
                // Defer the TestRunFinished send past the Mocha after-each hook window so
                // custom tags set in `afterEach` still make the payload (see field docs).
                // If a previous finish is somehow still pending for a DIFFERENT test, flush
                // it first; a re-stash for the same instance just replaces the stash.
                if (this.pendingTestFinish && (this.pendingTestFinish.args.instance as TestFrameworkInstance) !== instance) {
                    this.flushPendingTestFinishEvent()
                }
                this.pendingTestFinish = { args }
                this.logger.debug('onAllTestEvents: deferred TEST/POST send past the after-each hook window')
            } else {
                this.sendTestFrameworkEvent(args)
            }
        }
    }

    /**
     * Send a deferred TEST/POST (TestRunFinished) event, if one is pending. The instance's
     * CURRENT state may have moved on (e.g. LOG events during afterEach), so the send uses
     * an explicit TEST/POST state override; the payload data itself is read fresh from the
     * instance so late custom-tag merges are included. Called from onAllTestEvents at the
     * next test's boundary and from service.after() at worker end.
     */
    flushPendingTestFinishEvent(): Promise<void> | undefined {
        if (!this.pendingTestFinish) {
            return undefined
        }
        const { args } = this.pendingTestFinish
        this.pendingTestFinish = null
        this.logger.debug('flushPendingTestFinishEvent: sending deferred TEST/POST event')
        // SDK-7265: this is the only send of a mocha test's TestRunFinished, and the worker's last
        // test relies on this single flush from service.after(). A dropped send orphans the test →
        // Test Hub reaps it at its ~60-min idle timeout → the passing build is stamped `timeout`.
        // Retry with backoff. `args` is captured locally and the shared slot is only cleared (never
        // written back), so concurrent flushes can't clobber one another.
        const maxAttempts = 3
        const attempt = (n: number): Promise<void> =>
            this.sendTestFrameworkEvent(args, { testFrameworkState: 'TEST', testHookState: 'POST' }).then((sent) => {
                if (sent) {
                    return
                }
                this.logger.debug(`flushPendingTestFinishEvent: attempt ${n}/${maxAttempts} failed`)
                if (n >= maxAttempts) {
                    this.logger.error('flushPendingTestFinishEvent: deferred TEST/POST send failed after all retries')
                    return
                }
                return new Promise<void>((resolve) => setTimeout(resolve, 200 * n)).then(() => attempt(n + 1))
            })
        return attempt(1)
    }

    async sendTestFrameworkEvent(args: Record<string, unknown>, stateOverride?: { testFrameworkState: string, testHookState: string }): Promise<boolean> {
        try {
            const testArgs = args as { test: Frameworks.Test, instance: TestFrameworkInstance }
            const instance = testArgs.instance as TestFrameworkInstance
            const trackedContext = instance.getContext()
            const testData = instance.getAllData()
            const testFrameworkName = testData.get(TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME) || ''
            const testFrameworkVersion = testData.get(TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION) || ''
            const startedAt = testData.get(TestFrameworkConstants.KEY_TEST_STARTED_AT) || ''
            const endedAt = testData.get(TestFrameworkConstants.KEY_TEST_ENDED_AT) || ''
            const testFrameworkState = stateOverride?.testFrameworkState || instance.getCurrentTestState().toString().split('.')[1]
            const testHookState = stateOverride?.testHookState || instance.getCurrentHookState().toString().split('.')[1]

            this.logger.debug(`sendTestFrameworkEvent for testState: ${testFrameworkState} hookState: ${testHookState}`)
            const platformIndex = process.env.WDIO_WORKER_ID ? parseInt(process.env.WDIO_WORKER_ID.split('-')[0]) : 0
            const uuid = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_UUID) || instance.getRef()
            // Nested values such as test_hooks_started/test_hooks_finished are JS Maps, which
            // JSON.stringify would serialise to `{}` and strip the hook data. Convert any Map to
            // a plain object so the binary receives populated hook maps.
            const eventJson = Buffer.from(JSON.stringify(Object.fromEntries(testData), (_key, value) => value instanceof Map ? Object.fromEntries(value) : value))
            const executionContext = { hash: trackedContext.getId(), threadId: trackedContext.getThreadId().toString(), processId: trackedContext.getProcessId().toString() }
            const payload: Omit<TestFrameworkEventRequest, 'binSessionId'> = {
                platformIndex,
                testFrameworkName,
                testFrameworkVersion,
                testFrameworkState,
                testHookState,
                startedAt,
                endedAt,
                uuid,
                eventJson,
                executionContext
            }
            this.logger.debug(`sendTestFrameworkEvent payload: ${JSON.stringify(payload)}`)
            await GrpcClient.getInstance().testFrameworkEvent(payload)
            this.logger.debug(`sendTestFrameworkEvent complete for testState: ${testFrameworkState} hookState: ${testHookState}`)
            return true
        } catch (error) {
            this.logger.error(`Error in sendTestFrameworkEvent: ${util.format(error)}`)
            return false
        }
    }

    /**
     * Send test session event to the service
     * @param args containing test session data
     */
    async sendTestSessionEvent(args: Record<string, unknown>): Promise<void> {
        this.logger.debug('sendTestSessionEvent: Called')
        try {
            const instance = args.instance as TestFrameworkInstance
            const autoInstances = (args.autoInstance as AutomationFrameworkInstance[]) || []
            const trackedContext = instance.getContext()
            const testFWName = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME) as string
            const testFWVersion = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION) as string
            const testState = instance.getCurrentTestState().toString().split('.')[1]
            const hookState = instance.getCurrentHookState().toString().split('.')[1]
            this.logger.debug('sendTestSessionEvent: setup')

            const executionContext = {
                threadId: trackedContext.getThreadId().toString(),
                processId: trackedContext.getProcessId().toString()
            }

            const payload: Omit<TestSessionEventRequest, 'binSessionId'> = {
                testFrameworkName: testFWName,
                testFrameworkVersion: testFWVersion,
                testFrameworkState: testState.toString(),
                testHookState: hookState.toString(),
                testUuid: TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_UUID).toString(),
                executionContext,
                automationSessions: [],
                platformIndex: process.env.WDIO_WORKER_ID ? parseInt(process.env.WDIO_WORKER_ID.split('-')[0]) : 0,
                capabilities: new Uint8Array()
            }

            // Try to get capabilities from the first driver
            try {
                if (autoInstances.length > 0) {
                    const driver = AutomationFramework.getDriver(autoInstances[0]) as WebdriverIO.Browser // RemoteWebDriver equivalent
                    const userCaps = JSON.stringify(driver.capabilities)
                    if (userCaps) {
                        payload.capabilities = new TextEncoder().encode(userCaps)
                    }
                }
            } catch (error) {
                this.logger.debug(`Error while getting capabilities from driver: ${error}`)
            }

            this.logger.debug(`sendTestSessionEvent: instance iteration ${JSON.stringify(autoInstances)}`)
            // LTS: BLU runner pods route through a local Selenium hub
            // so KEY_IS_BROWSERSTACK_HUB resolves to false — without
            // this gate the AutomationSession lands with provider=
            // unknown_grid and TestHub's o11y classifier sets
            // test_run.origin=UnknownGrid. Mirrors py-sdk 3af3bba6
            // (force provider='browserstack' + product='loadTesting'
            // under LTS) and 0efca1ae (override frameworkSessionId
            // with the LTS pod-iteration env id).
            // Hoisted above the loop — env vars are stable for the
            // process lifetime, no need to re-read per iteration.
            const ltsActive = isLoadTestingSession()
            const ltsSessionId = ltsActive ? getLtsSessionId() : ''
            // Process automation instances
            for (const autoInstance of autoInstances) {
                const sessionProvider = ltsActive
                    ? 'browserstack'
                    : (AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_IS_BROWSERSTACK_HUB) as boolean
                        ? 'browserstack'
                        : 'unknown_grid')

                // Null-safe: under LTS the local-Selenium AutomationFrameworkInstance
                // may not have KEY_FRAMEWORK_SESSION_ID populated yet (the binary's
                // hub assigns sessionId later than KEY_IS_BROWSERSTACK_HUB). Without
                // the guard, AutomationFramework.getState returns undefined and the
                // chained .toString() throws TypeError before the (ltsActive &&
                // ltsSessionId) ternary on line 215 has a chance to fall through to
                // ltsSessionId. Default to '' so the ternary path stays untouched
                // and the non-LTS fall-through is still safe.
                const driverFrameworkSessionId = (
                    AutomationFramework.getState(
                        autoInstance,
                        AutomationFrameworkConstants.KEY_FRAMEWORK_SESSION_ID,
                    )?.toString() ?? ''
                )

                const automationSession: AutomationSession = {
                    provider: sessionProvider,
                    ref: autoInstance.getRef(),
                    hubUrl: this.config.hubUrl as string,
                    frameworkSessionId: (ltsActive && ltsSessionId) ? ltsSessionId : driverFrameworkSessionId,
                    frameworkName: autoInstance.frameworkName,
                    frameworkVersion: autoInstance.frameworkVersion,
                    ...(ltsActive ? { product: 'loadTesting' } : {})
                }
                this.logger.debug(`sendTestSessionEvent: automationSession: ${JSON.stringify(automationSession)}`)

                payload.platformIndex = process.env.WDIO_WORKER_ID ? parseInt(process.env.WDIO_WORKER_ID.split('-')[0]) : 0
                payload.automationSessions.push(automationSession)
            }

            this.logger.debug(`sendTestSessionEvent payload: ${JSON.stringify(payload)}`)
            await GrpcClient.getInstance().testSessionEvent(payload)
            this.logger.debug(`sendTestSessionEvent complete for testState: ${testState} hookState: ${hookState}`)
        } catch (error) {
            this.logger.error(`sendTestSessionEvent: Error sending grpc call: event=${JSON.stringify(args)}, error=${error}`)
            throw new Error(`Failed to send test session event: ${error}`)
        }
    }

    async sendLogCreatedEvent(args: Record<string, unknown>) {
        try {
            const testArgs = args as { test: Frameworks.Test, instance: TestFrameworkInstance }
            const logEntries = args.logEntries as Array<Record<string, unknown>>
            const instance = testArgs.instance as TestFrameworkInstance
            const trackedContext = instance.getContext()
            const testData = instance.getAllData()
            const testFrameworkName = testData.get(TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME) || ''
            const testFrameworkVersion = testData.get(TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION) || ''
            const testFrameworkState = instance.getCurrentTestState().toString().split('.')[1]
            const testHookState = instance.getCurrentHookState().toString().split('.')[1]

            this.logger.debug(`sendLogCreatedEvent testId: testFrameworkState: ${testFrameworkState} testHookState: ${testHookState}`)
            const platformIndex = process.env.WDIO_WORKER_ID ? parseInt(process.env.WDIO_WORKER_ID.split('-')[0]) : 0
            const executionContext = { hash: trackedContext.getId(), threadId: trackedContext.getThreadId().toString(), processId: trackedContext.getProcessId().toString() }
            const payload: Omit<LogCreatedEventRequest, 'binSessionId'> = {
                platformIndex,
                logs: [],
                executionContext
            }
            for (const logEntry of logEntries) {
                // eslint-disable-next-line camelcase
                const logData: LogCreatedEventRequest_LogEntry = {
                    testFrameworkName,
                    testFrameworkVersion,
                    testFrameworkState,
                    uuid: logEntry[TestFrameworkConstants.KEY_HOOK_ID] || TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_UUID),
                    kind: logEntry.kind as string,
                    message: logEntry.message as Uint8Array,
                    timestamp: logEntry.timestamp as string,
                    level: logEntry.level as string,
                }
                payload.logs.push(logData)
            }
            this.logger.debug(`sendLogCreatedEvent payload: ${JSON.stringify(payload)}`)
            await GrpcClient.getInstance().logCreatedEvent(payload)
            this.logger.debug(`sendLogCreatedEvent complete for testState: ${testFrameworkState} hookState: ${testHookState}`)
        } catch (error) {
            this.logger.error(`Error in sendLogCreatedEvent: ${util.format(error)}`)
        }
    }
}
