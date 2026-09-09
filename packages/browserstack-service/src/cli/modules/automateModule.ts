import BaseModule from './baseModule.js'
import { BStackLogger } from '../cliLogger.js'
import TestFramework from '../frameworks/testFramework.js'
import { TestFrameworkState } from '../states/testFrameworkState.js'
import { HookState } from '../states/hookState.js'
import type { Frameworks, Options } from '@wdio/types'
import AutomationFramework from '../frameworks/automationFramework.js'
import { AutomationFrameworkConstants } from '../frameworks/constants/automationFrameworkConstants.js'
import { isBrowserstackSession, isTrue } from '../../util.js'
import type TestFrameworkInstance from '../instances/testFrameworkInstance.js'
import { TestFrameworkConstants } from '../frameworks/constants/testFrameworkConstants.js'
import PerformanceTester from '../../instrumentation/performance/performance-tester.js'
import * as PERFORMANCE_SDK_EVENTS from '../../instrumentation/performance/constants.js'
import APIUtils from '../apiUtils.js'
import { AutomationFrameworkState } from '../states/automationFrameworkState.js'
import { _fetch as fetch } from '../../fetchWrapper.js'

import util from 'node:util'

interface TestResult {
    testName: string
    status: 'passed' | 'failed'
    reason?: string
}

interface SessionData {
    lastTestName: string
    appliedName?: string // last name successfully PUT for this session, for de-duping
    testResults: Map<string, TestResult> // testName -> TestResult
    scenariosRan: number // non-skipped cucumber scenarios, for preferScenarioName
    lastScenarioName?: string
    preferScenarioName?: boolean
}

export default class AutomateModule extends BaseModule {

    logger = BStackLogger
    browserStackConfig: Options.Testrunner
    private sessionMap: Map<string, SessionData> = new Map()

    static readonly MODULE_NAME = 'AutomateModule'
    /**
     * Create a new AutomateModule
     */
    constructor(browserStackConfig: Options.Testrunner) {
        super()
        this.browserStackConfig = browserStackConfig
        this.logger.info('AutomateModule: Initializing Automate Module')
        TestFramework.registerObserver(TestFrameworkState.TEST, HookState.PRE, this.onBeforeTest.bind(this))
        TestFramework.registerObserver(TestFrameworkState.TEST, HookState.POST, this.onAfterTest.bind(this))
        TestFramework.registerObserver(AutomationFrameworkState.EXECUTE, HookState.POST, this.onAfterExecute.bind(this))
        // Build-level hooks carry no scenario result, so they reach the session verdict only
        // through their own state. See onBuildLevelHookEnd — cucumber-gated inside the handler.
        TestFramework.registerObserver(TestFrameworkState.BEFORE_ALL, HookState.POST, this.onBuildLevelHookEnd.bind(this, 'BEFORE_ALL'))
        TestFramework.registerObserver(TestFrameworkState.AFTER_ALL, HookState.POST, this.onBuildLevelHookEnd.bind(this, 'AFTER_ALL'))
    }

    getModuleName(): string {
        return AutomateModule.MODULE_NAME
    }

    async onBeforeTest(args: Record<string, unknown>) {
        this.logger.info('onbeforeTest: inside automate module before test hook!')
        const instace = args.instance as TestFrameworkInstance
        const autoInstance = AutomationFramework.getTrackedInstance()
        const sessionId = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_FRAMEWORK_SESSION_ID)
        const browser = AutomationFramework.getDriver(autoInstance) as WebdriverIO.Browser
        const test = args.test as Frameworks.Test
        const testTitle = test.title as string
        const suiteTitle = args.suiteTitle as string
        const testContextOptions = this.config.testContextOptions as TestContextOptions

        if (testContextOptions.skipSessionName || !isBrowserstackSession(browser)) {
            this.logger.info('Skipping session name update as per configuration')
            return
        }

        let name = suiteTitle
        if (testContextOptions.sessionNameFormat) {
            const caps = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_CAPABILITIES)
            name = testContextOptions.sessionNameFormat(
                this.browserStackConfig,
                caps,
                suiteTitle,
                testTitle
            )
        } else if (test && !test.fullName) {
            // Mocha
            const pre = testContextOptions.sessionNamePrependTopLevelSuiteTitle ? `${suiteTitle} - ` : ''
            const post = !testContextOptions.sessionNameOmitTestTitle ? ` - ${testTitle}` : ''
            name = `${pre}${test.parent}${post}`
        }

        const existingSession = this.sessionMap.get(sessionId)
        if (!existingSession) {
            this.sessionMap.set(sessionId, {
                lastTestName: name,
                testResults: new Map(),
                scenariosRan: 0
            })
        } else {
            existingSession.lastTestName = name
            this.sessionMap.set(sessionId, existingSession)
        }

        TestFramework.setState(instace, TestFrameworkConstants.KEY_AUTOMATE_SESSION_NAME, name)

        // SDK-7270: name the session NOW, while it is still the live session, instead of
        // relying solely on the onAfterExecute sweep at worker teardown. Sessions are closed
        // as soon as the suite reloads them (`browser.reloadSession()` per test), and a worker
        // that never reaches `after()` — interrupted run, hard exit, crash — never fires
        // onAfterExecute at all, leaving every session on the creation-time `sessionName`
        // capability. Restores the pre-9.27 behaviour, where the rename was issued per test.
        await this.flushSessionName(sessionId)
    }

    /**
     * PUT the session's current name if it has not already been applied.
     * De-duped via `appliedName` so the onAfterExecute sweep does not re-send it.
     */
    private async flushSessionName(sessionId: string): Promise<void> {
        const testContextOptions = this.config.testContextOptions as TestContextOptions
        if (testContextOptions.skipSessionName) {
            return
        }

        if (!sessionId) {
            return
        }

        const sessionData = this.sessionMap.get(sessionId)
        if (!sessionData || !sessionData.lastTestName || sessionData.appliedName === sessionData.lastTestName) {
            return
        }

        const name = sessionData.lastTestName
        await this.markSessionName(sessionId, name, {
            user: this.config.userName as string,
            key: this.config.accessKey as string
        })
        sessionData.appliedName = name
        this.sessionMap.set(sessionId, sessionData)
    }

    async onAfterTest(args: Record<string, unknown>) {
        this.logger.debug('onAfterTest: inside automate module after test hook!')
        const instace = args.instance as TestFrameworkInstance
        const { error, passed, skipped } = args.result as { error: Error | null, passed: boolean, skipped?: boolean }
        const _failReasons: string[] = []

        if (!passed && !skipped) {
            _failReasons.push((error && error.message) || 'Unknown Error')
        }

        const status = passed || skipped ? 'passed' : 'failed'
        const reason = _failReasons.length > 0 ? _failReasons.join('\n') : undefined

        const autoInstance = AutomationFramework.getTrackedInstance()
        const sessionId = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_FRAMEWORK_SESSION_ID)
        const browser = AutomationFramework.getDriver(autoInstance) as WebdriverIO.Browser
        const test = args.test as Frameworks.Test
        const testTitle = test.title as string
        const suiteTitle = args.suiteTitle as string
        const testContextOptions = this.config.testContextOptions as TestContextOptions

        if (!isBrowserstackSession(browser)) {
            this.logger.info('Skipping session status update as per configuration')
            return
        }

        let name = suiteTitle
        if (testContextOptions.sessionNameFormat) {
            const caps = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_CAPABILITIES)
            name = testContextOptions.sessionNameFormat(
                this.browserStackConfig,
                caps,
                suiteTitle,
                testTitle
            )
        } else if (test && !test.fullName) {
            // Mocha
            const pre = testContextOptions.sessionNamePrependTopLevelSuiteTitle ? `${suiteTitle} - ` : ''
            const post = !testContextOptions.sessionNameOmitTestTitle ? ` - ${testTitle}` : ''
            name = `${pre}${test.parent}${post}`
        }

        // SDK-7270 (residual): the session can be REPLACED mid-test. @wdio/mocha-framework binds
        // beforeTest to the test function itself (wrapGlobalTestMethod), so onBeforeTest is the one
        // and only per-test naming opportunity and it has already passed by the time the test body
        // calls browser.reloadSession(). The replacement session is therefore never registered in
        // sessionMap and keeps its creation-time `sessionName` capability. (A reload in a beforeEach
        // hook is fine — that runs before beforeTest.) Re-resolve the live session id here
        // (service.onReload has already pointed KEY_FRAMEWORK_SESSION_ID at it) and adopt it while
        // it is still open.
        //
        // Deliberately gated on skipSessionName, NOT skipSessionStatus: naming and status are
        // independent options, so a `setSessionStatus: false` user must still get the name repair,
        // and a `setSessionName: false` user must not be pulled into sessionMap — that would hand
        // onAfterExecute a session to status-mark where it previously had none.
        if (sessionId && !testContextOptions.skipSessionName && !this.sessionMap.has(sessionId)) {
            this.sessionMap.set(sessionId, { lastTestName: name, testResults: new Map(), scenariosRan: 0 })
        }
        // No-op for the steady state: when no mid-test reload happened, onBeforeTest already
        // applied this exact name and `appliedName` de-dupes it away — no extra API call.
        await this.flushSessionName(sessionId)

        if (testContextOptions.skipSessionStatus) {
            this.logger.info('Skipping session status update as per configuration')
            return
        }

        const testResult: TestResult = {
            testName: name,
            status: status,
            reason: reason
        }

        const sessionData = this.sessionMap.get(sessionId)
        if (sessionData) {
            // `name` is the session NAME, which for cucumber is the Feature title and therefore
            // shared by every scenario in the file — keying the results map on it collapses N
            // scenarios into one last-write-wins entry, so a feature whose last scenario passes
            // reports a passed session however many earlier ones failed. Mocha leaves `fullName`
            // undefined, so the key is unchanged there.
            const resultKey = (test && test.fullName) ? String(test.fullName) : name
            sessionData.testResults.set(resultKey, testResult)
            if (!skipped && this.isCucumberInstance(instace)) {
                sessionData.scenariosRan++
                sessionData.lastScenarioName = testTitle
                sessionData.preferScenarioName = isTrue(args.preferScenarioName)
            }
            this.sessionMap.set(sessionId, sessionData)
        }

        TestFramework.setState(instace, TestFrameworkConstants.KEY_AUTOMATE_SESSION_STATUS, status)
        TestFramework.setState(instace, TestFrameworkConstants.KEY_AUTOMATE_SESSION_REASON, reason)
    }

    /**
     * A `BeforeAll` / `AfterAll` failure produces no scenario result, so it can never enter the
     * per-test `testResults` map that onAfterExecute aggregates — a run whose BeforeAll blew up
     * reports its session as PASSED. Legacy pushed the hook error into `_failReasons` and
     * `after()` marked the session failed; that whole accumulation is gated
     * `setSessionStatus && !BrowserstackCLI.isRunning()`, so it is dead while the binary is up.
     *
     * Cucumber-gated deliberately. `wdio_mocha` has the identical latent shape on this flow, but
     * legacy mocha behaved the same way, so repairing it here would be an unrequested behaviour
     * change to the one framework already working on the CLI flow.
     */
    async onBuildLevelHookEnd(hookKey: string, args: Record<string, unknown>) {
        try {
            const instance = (args?.instance as TestFrameworkInstance) || TestFramework.getTrackedInstance()
            if (!instance || !this.isCucumberInstance(instance)) {
                return
            }

            const result = args?.result as { passed?: boolean, error?: Error } | undefined
            if (!result || result.passed) {
                return
            }

            const testContextOptions = this.config.testContextOptions as TestContextOptions
            if (testContextOptions?.skipSessionStatus) {
                return
            }

            const autoInstance = AutomationFramework.getTrackedInstance()
            const sessionId = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_FRAMEWORK_SESSION_ID)
            if (!sessionId) {
                this.logger.debug(`onBuildLevelHookEnd: no session id resolved for ${hookKey}; nothing to mark`)
                return
            }

            const sessionData = this.sessionMap.get(sessionId)
            // Keyed on the absence of scenario results, never on the flag: legacy's
            // `ignoreHooksStatus && this._specsRan` arm needs BOTH, and with no scenario recorded it
            // falls through to marking `failed` regardless of the flag. The count is final here — a
            // `BeforeAll` failure aborts the run, and by `AfterAll` every scenario has been recorded.
            const specsRan = (sessionData?.testResults.size ?? 0) > 0
            if (specsRan && isTrue(args?.ignoreHooksStatus)) {
                this.logger.debug(`onBuildLevelHookEnd: ${hookKey} failed but ignoreHooksStatus is set; not failing the session`)
                return
            }

            if (!sessionData) {
                // A BeforeAll can fail before any scenario ran, so the session may not be
                // registered yet. `lastTestName` stays empty on purpose — flushSessionName
                // early-returns on it, so registering here cannot rename the session.
                this.sessionMap.set(sessionId, { lastTestName: '', testResults: new Map(), scenariosRan: 0 })
            }

            const name = this.resolveHookName(instance, hookKey)
            this.sessionMap.get(sessionId)!.testResults.set(name, {
                testName: name,
                status: 'failed',
                reason: (result.error && result.error.message) || 'Hook failed'
            })
            this.logger.info(`onBuildLevelHookEnd: recorded ${hookKey} failure against session ${sessionId}`)
        } catch (error) {
            this.logger.error(`Exception in automate onBuildLevelHookEnd: ${error}`)
        }
    }

    private isCucumberInstance(instance: TestFrameworkInstance): boolean {
        const frameworkName = String(TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME) || '')
        return frameworkName.toLowerCase().includes('cucumber')
    }

    /** The hook's reported name (`BEFORE_ALL for <feature>`), so the session reason names the hook. */
    private resolveHookName(instance: TestFrameworkInstance, hookKey: string): string {
        try {
            const finished = TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOKS_FINISHED) as Map<string, Record<string, unknown>[]> | undefined
            const hooks = finished?.get(hookKey)
            const hookName = hooks?.length ? hooks[hooks.length - 1][TestFrameworkConstants.KEY_HOOK_NAME] : undefined
            return (hookName as string) || hookKey
        } catch {
            return hookKey
        }
    }

    async onAfterExecute() {
        this.logger.debug('onAfterExecute: inside automate module after execute hook!')

        const userName = this.config.userName as string
        const accessKey = this.config.accessKey as string
        const testContextOptions = this.config.testContextOptions as TestContextOptions

        for (const [sessionId, sessionData] of this.sessionMap.entries()) {
            try {
                const failedTests = Array.from(sessionData.testResults.values()).filter(test => test.status === 'failed')
                const hasFailures = failedTests.length > 0
                const sessionStatus = hasFailures ? 'failed' : 'passed'

                let failureReason: string | undefined
                if (hasFailures) {
                    if (failedTests.length === 1) {
                        failureReason = failedTests[0].reason || 'Test failed'
                    } else {
                        const reasonLines = failedTests.map(test =>
                            `${test.testName}: ${test.reason || 'Unknown Error'}`
                        )
                        failureReason = reasonLines.join(',\n')
                    }
                }

                // preferScenarioName: cucumber names the session after the FEATURE, but when
                // exactly one non-skipped scenario ran the user can ask for that scenario's name
                // instead. Only decidable here — "exactly one" is not knowable while tests are
                // still arriving. `skipSessionName` still wins, inside flushSessionName.
                if (sessionData.preferScenarioName && sessionData.scenariosRan === 1 && sessionData.lastScenarioName) {
                    sessionData.lastTestName = sessionData.lastScenarioName
                    this.sessionMap.set(sessionId, sessionData)
                }

                // Final sweep — a no-op for sessions already named per-test in onBeforeTest.
                await this.flushSessionName(sessionId)

                if (!testContextOptions.skipSessionStatus) {
                    await this.markSessionStatus(sessionId, sessionStatus, failureReason, { user: userName, key: accessKey })
                }
            } catch (error) {
                this.logger.error(`Failed to process session ${sessionId}: ${error}`)
            }
        }

        this.sessionMap.clear()
    }

    // An App Automate session is identified by the service-level app / skipAppOverride flag,
    // OR an app supplied only via the appium:app / appium:options.app capability — which the
    // service-level config (this.config) does not carry. Mirrors accessibilityModule.isAppAutomateSession.
    private isAppAutomate(): boolean {
        if (this.config.app || isTrue(this.config.skipAppOverride)) {
            return true
        }
        return this.hasAppCapInFrameworkState()
    }

    // The binary echoes the parsed `turboScale` flag back on the session config; the env var is
    // written unconditionally by the service constructor in this same worker process, so it stands
    // in when a config shape predates the flag.
    private isTurboScale(): boolean {
        return isTrue(this.config.turboScale) || isTrue(process.env.BROWSERSTACK_TURBOSCALE_INTERNAL)
    }

    /**
     * Resolve the REST endpoint a session marker must hit.
     *
     * Turboscale is not a variant of Automate here — it is a different API on a different path
     * with a different VERB (PATCH, not PUT). The legacy path expressed this through
     * `_sessionBaseUrl` + `_update()`, both gated `!BrowserstackCLI.isRunning()`, so neither
     * survives onto the CLI flow and nothing in the binary compensates.
     *
     * Precedence mirrors legacy's assignment order in `beforeSession()`: the turboscale base URL
     * is assigned AFTER the app-automate one, so a turboscale grid wins even with an app cap set.
     *
     * Single resolver for both markers deliberately: naming and status previously duplicated the
     * ternary, which is how the two can drift apart.
     */
    private resolveSessionApi(sessionId: string): { url: string, method: 'PUT' | 'PATCH', product: string } {
        if (this.isTurboScale()) {
            return {
                url: `${APIUtils.BROWSERSTACK_AUTOMATE_API_URL}/automate-turboscale/v1/sessions/${sessionId}.json`,
                method: 'PATCH',
                product: 'Automate TurboScale'
            }
        }
        if (this.isAppAutomate()) {
            return {
                url: `${APIUtils.BROWSERSTACK_AA_API_URL}/app-automate/sessions/${sessionId}.json`,
                method: 'PUT',
                product: 'App Automate'
            }
        }
        return {
            url: `${APIUtils.BROWSERSTACK_AUTOMATE_API_URL}/automate/sessions/${sessionId}.json`,
            method: 'PUT',
            product: 'Automate'
        }
    }

    async markSessionName(sessionId: string, sessionName: string, config: { user: string; key: string; }): Promise<void> {
        return await PerformanceTester.measureWrapper(
            PERFORMANCE_SDK_EVENTS.AUTOMATE_EVENTS.SESSION_NAME,
            async (sessionId: string, sessionName: string, config: { user: string; key: string; }) => {
                try {
                    const auth = Buffer.from(`${config.user}:${config.key}`).toString('base64')
                    const { url: sessionNameApiUrl, method, product } = this.resolveSessionApi(sessionId)
                    this.logger.info(`Marking session name for ${product}`)

                    const requestBody = {
                        name: sessionName
                    }

                    const options = {
                        method,
                        headers: {
                            Authorization: `Basic ${auth}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(requestBody)
                    }

                    const response = await fetch(sessionNameApiUrl, options)
                    const responseData = await response.json()
                    this.logger.debug(`Session name updated: ${util.format(responseData)}. Done for sessionId ${sessionId}`)
                } catch (err) {
                    this.logger.error(`Failed to update session name on BrowserStack: ${err}`)
                }
            }
        )(sessionId, sessionName, config)
    }

    async markSessionStatus(sessionId: string, sessionStatus: 'passed' | 'failed', sessionErrorMessage: string | undefined, config: { user: string; key: string; }): Promise<void> {
        return await PerformanceTester.measureWrapper(
            PERFORMANCE_SDK_EVENTS.AUTOMATE_EVENTS.SESSION_STATUS,
            async (sessionId: string, sessionStatus: 'passed' | 'failed', sessionErrorMessage: string | undefined, config: { user: string; key: string; }) => {
                try {
                    const auth = Buffer.from(`${config.user}:${config.key}`).toString('base64')
                    const { url: sessionStatusApiUrl, method, product } = this.resolveSessionApi(sessionId)
                    this.logger.info(`Marking session status for ${product}`)

                    const body = {
                        status: sessionStatus,
                        ...(sessionErrorMessage ? { reason: sessionErrorMessage } : {})
                    }

                    const options = {
                        method,
                        headers: {
                            Authorization: `Basic ${auth}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(body)
                    }

                    const response = await fetch(sessionStatusApiUrl, options)
                    const responseData = await response.json()
                    this.logger.debug(`Session status updated: ${util.format(responseData)}. Done for sessionId ${sessionId}`)
                } catch (err) {
                    this.logger.error(`Failed to update session status on BrowserStack: ${err}`)
                }
            }
        )(sessionId, sessionStatus, sessionErrorMessage, config)
    }

}
