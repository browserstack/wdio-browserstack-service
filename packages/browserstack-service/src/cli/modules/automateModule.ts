import BaseModule from './baseModule.js'
import { BStackLogger } from '../cliLogger.js'
import TestFramework from '../frameworks/testFramework.js'
import { TestFrameworkState } from '../states/testFrameworkState.js'
import { HookState } from '../states/hookState.js'
import got from 'got'
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

interface TestResult {
    testName: string
    status: 'passed' | 'failed'
    reason?: string
}

interface SessionData {
    lastTestName: string
    testResults: Map<string, TestResult> // testName -> TestResult
}

export default class AutomateModule extends BaseModule {

    logger = BStackLogger
    browserStackConfig: Options.Testrunner
    // The live, in-process service options. Injected rather than imported: cli/index.ts constructs
    // this module, so importing it back would close an ESM cycle.
    private serviceOptions: Record<string, any>
    private sessionMap: Map<string, SessionData> = new Map()

    static readonly MODULE_NAME = 'AutomateModule'
    /**
     * Create a new AutomateModule
     */
    constructor(browserStackConfig: Options.Testrunner, serviceOptions: Record<string, any> = {}) {
        super()
        this.browserStackConfig = browserStackConfig
        this.serviceOptions = serviceOptions
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

        if (!isBrowserstackSession(browser)) {
            return
        }

        // `setSessionName: false` suppresses the NAME, not the registration. The session still has
        // to enter sessionMap or onAfterExecute has nothing to status-mark, and legacy marks it
        // either way — its after() status block gates on setSessionStatus alone. Registering with
        // an empty lastTestName is safe because onAfterExecute's naming call is guarded on both
        // the flag and a non-empty name, so no name can be sent from here.
        if (testContextOptions.skipSessionName) {
            this.logger.info('Skipping session name update as per configuration')
            if (sessionId && !this.sessionMap.has(sessionId)) {
                this.sessionMap.set(sessionId, { lastTestName: '', testResults: new Map() })
            }
            return
        }

        let name = suiteTitle
        // Resolved from the live in-process options, NOT from testContextOptions: that config is
        // round-tripped through the binary as JSON, which silently drops function-valued keys, so
        // testContextOptions.sessionNameFormat is always absent. Reading it here keeps every naming
        // decision inside this module instead of splitting it across the legacy path.
        const sessionNameFormat = this.serviceOptions?.sessionNameFormat
        if (sessionNameFormat) {
            const caps = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_CAPABILITIES)
            name = sessionNameFormat(
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
                testResults: new Map()
            })
        } else {
            existingSession.lastTestName = name
            this.sessionMap.set(sessionId, existingSession)
        }

        TestFramework.setState(instace, TestFrameworkConstants.KEY_AUTOMATE_SESSION_NAME, name)
    }

    async onAfterTest(args: Record<string, unknown>) {
        this.logger.debug('onAfterTest: inside automate module after test hook!')
        const instace = args.instance as TestFrameworkInstance
        const { error, passed, skipped } = args.result as { error: Error | null, passed: boolean, skipped?: boolean }
        const _failReasons: string[] = []

        // A skipped cucumber scenario must not fail the session: legacy accumulates _failReasons
        // only for _failureStatuses (failed/ambiguous/undefined/unknown), which excludes skipped.
        // Cucumber-scoped on purpose — mocha's collapse is its own long-standing behaviour on this
        // flow and changing it here would alter a framework already shipping on the CLI.
        const treatAsPassed = passed || Boolean(skipped && this.isCucumberInstance(instace))

        if (!treatAsPassed) {
            _failReasons.push((error && error.message) || 'Unknown Error')
        }

        const status = treatAsPassed ? 'passed' : 'failed'
        const reason = _failReasons.length > 0 ? _failReasons.join('\n') : undefined

        const autoInstance = AutomationFramework.getTrackedInstance()
        const sessionId = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_FRAMEWORK_SESSION_ID)
        const browser = AutomationFramework.getDriver(autoInstance) as WebdriverIO.Browser
        const test = args.test as Frameworks.Test
        const testTitle = test.title as string
        const suiteTitle = args.suiteTitle as string
        const testContextOptions = this.config.testContextOptions as TestContextOptions

        if (testContextOptions.skipSessionStatus || !isBrowserstackSession(browser)) {
            this.logger.info('Skipping session status update as per configuration')
            return
        }

        let name = suiteTitle
        // See onBeforeTest: the formatter exists only in-process; the round-tripped config drops it.
        const sessionNameFormat = this.serviceOptions?.sessionNameFormat
        if (sessionNameFormat) {
            const caps = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_CAPABILITIES)
            name = sessionNameFormat(
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

        const sessionData = this.sessionMap.get(sessionId)
        if (sessionData) {
            const testResult: TestResult = {
                testName: name,
                status: status,
                reason: reason
            }

            // `name` is the session NAME, which for cucumber is the Feature title and therefore
            // shared by every scenario in the file — keying on it collapses N scenarios into one
            // last-write-wins entry, so a feature whose last scenario passes reports a passed
            // session however many earlier ones failed. Mocha leaves `fullName` undefined, so its
            // key is unchanged.
            const resultKey = (test && test.fullName) ? String(test.fullName) : name
            sessionData.testResults.set(resultKey, testResult)
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
            // Keyed on the absence of scenario results, never on the flag alone: legacy's
            // `ignoreHooksStatus && this._specsRan` arm needs BOTH, and with no scenario recorded
            // it falls through to marking `failed` regardless of the flag. The count is final
            // here — a BeforeAll failure aborts the run, and by AfterAll every scenario is in.
            const specsRan = (sessionData?.testResults.size ?? 0) > 0
            if (specsRan && isTrue(args?.ignoreHooksStatus)) {
                this.logger.debug(`onBuildLevelHookEnd: ${hookKey} failed but ignoreHooksStatus is set; not failing the session`)
                return
            }

            if (!sessionData) {
                // A BeforeAll can fail before any scenario ran, so the session may not be
                // registered yet. `lastTestName` stays empty on purpose: onAfterExecute's naming
                // call is what consumes it, and an empty name is what beforeFeature's own
                // (un-gated) _setSessionName has already applied.
                this.sessionMap.set(sessionId, { lastTestName: '', testResults: new Map() })
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

                // An empty name means nothing ever named this session — a BeforeAll that failed
                // before any feature loaded, so beforeFeature never ran. Legacy makes no naming
                // call at all in that state; PUTting '' would be an API call it never made.
                if (!testContextOptions.skipSessionName && sessionData.lastTestName) {
                    await this.markSessionName(sessionId, sessionData.lastTestName, { user: userName, key: accessKey })
                }

                if (!testContextOptions.skipSessionStatus) {
                    await this.markSessionStatus(sessionId, sessionStatus, failureReason, { user: userName, key: accessKey })
                }
            } catch (error) {
                this.logger.error(`Failed to process session ${sessionId}: ${error}`)
            }
        }

        this.sessionMap.clear()
    }

    async markSessionName(sessionId: string, sessionName: string, config: { user: string; key: string;}): Promise<void> {
        return await PerformanceTester.measureWrapper(
            PERFORMANCE_SDK_EVENTS.AUTOMATE_EVENTS.SESSION_NAME,
            async (sessionId: string, sessionName: string, config: { user: string; key: string;}) => {
                try {
                    const auth = Buffer.from(`${config.user}:${config.key}`).toString('base64')
                    // skipAppOverride runs App Automate without an app value, so route session
                    // name/status to the App Automate endpoint on the flag too (config echoed from
                    // the binary carries skipAppOverride via the binconfig service options).
                    const isAppAutomate = this.config.app || isTrue(this.config.skipAppOverride)
                    if (isAppAutomate) {
                        this.logger.info('Marking session name for App Automate')
                    } else {
                        this.logger.info('Marking session name for Automate')
                    }

                    const sessionStatusApiUrl = isAppAutomate
                        ? `${APIUtils.BROWSERSTACK_AA_API_URL}/app-automate/sessions/${sessionId}.json`
                        : `${APIUtils.BROWSERSTACK_AUTOMATE_API_URL}/automate/sessions/${sessionId}.json`

                    const requestBody = {
                        name: sessionName
                    }

                    const options: any = {
                        method: 'PUT',
                        url: sessionStatusApiUrl,
                        headers: {
                            Authorization: `Basic ${auth}`,
                            'Content-Type': 'application/json'
                        },
                        json: requestBody,
                        responseType: 'json'
                    }

                    const response = await got(options)
                    this.logger.debug('Session name updated:', response.body)
                    this.logger.debug(`Done for sessionId ${sessionId}`)
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
                    // skipAppOverride runs App Automate without an app value, so route session
                    // name/status to the App Automate endpoint on the flag too (config echoed from
                    // the binary carries skipAppOverride via the binconfig service options).
                    const isAppAutomate = this.config.app || isTrue(this.config.skipAppOverride)
                    if (isAppAutomate) {
                        this.logger.info('Marking session status for App Automate')
                    } else {
                        this.logger.info('Marking session status for Automate')
                    }

                    const sessionStatusApiUrl = isAppAutomate
                        ? `${APIUtils.BROWSERSTACK_AA_API_URL}/app-automate/sessions/${sessionId}.json`
                        : `${APIUtils.BROWSERSTACK_AUTOMATE_API_URL}/automate/sessions/${sessionId}.json`

                    const body = {
                        status: sessionStatus,
                        ...(sessionErrorMessage ? { reason: sessionErrorMessage } : {})
                    }

                    const options: any = {
                        method: 'PUT',
                        url: sessionStatusApiUrl,
                        headers: {
                            Authorization: `Basic ${auth}`,
                            'Content-Type': 'application/json'
                        },
                        json: body,
                        responseType: 'json'
                    }

                    const response = await got(options)
                    this.logger.debug('Session update response:', response.body)
                } catch (err) {
                    this.logger.error(`Failed to update session status on BrowserStack: ${err}`)
                }
            }
        )(sessionId, sessionStatus, sessionErrorMessage, config)
    }

}
