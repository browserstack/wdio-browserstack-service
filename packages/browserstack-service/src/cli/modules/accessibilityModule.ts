import BaseModule from './baseModule.js'
import { BrowserstackCLI } from '../index.js'
import { BStackLogger } from '../cliLogger.js'
import TestFramework from '../frameworks/testFramework.js'
import AutomationFramework from '../frameworks/automationFramework.js'
import type AutomationFrameworkInstance from '../instances/automationFrameworkInstance.js'
import type TestFrameworkInstance from '../instances/testFrameworkInstance.js'
import { TestFrameworkState } from '../states/testFrameworkState.js'
import { AutomationFrameworkState } from '../states/automationFrameworkState.js'
import { HookState } from '../states/hookState.js'
import type { Command } from '../../scripts/accessibility-scripts.js'
import accessibilityScripts from '../../scripts/accessibility-scripts.js'
import { _getParamsForAppAccessibility, formatString, getAppA11yResults, getAppA11yResultsSummary, shouldScanTestForAccessibility, validateCapsWithA11y, validateCapsWithAppA11y, isBrowserstackSession } from '../../util.js'
import { AutomationFrameworkConstants } from '../frameworks/constants/automationFrameworkConstants.js'
import util from 'node:util'
import type { Accessibility } from '../../grpc/index.js'
import PerformanceTester from '../../instrumentation/performance/performance-tester.js'
import * as PERFORMANCE_SDK_EVENTS from '../../instrumentation/performance/constants.js'
import type { FetchDriverExecuteParamsEventRequest, FetchDriverExecuteParamsEventResponse } from '../../grpc/index.js'
import { GrpcClient } from '../grpcClient.js'
import { TestFrameworkConstants } from '../frameworks/constants/testFrameworkConstants.js'

export default class AccessibilityModule extends BaseModule {

    logger = BStackLogger
    name: string
    scriptInstance: typeof accessibilityScripts
    accessibility: boolean = false
    autoScanning: boolean = true
    isAppAccessibility: boolean
    isNonBstackA11y: boolean
    accessibilityConfig: Accessibility
    static MODULE_NAME = 'AccessibilityModule'
    accessibilityMap: Map<string, boolean>
    LOG_DISABLED_SHOWN: Map<string, boolean>
    testMetadata: Record<string, { [key: string]: unknown; }> = {}
    currentTestName: string | null = null
    // The run uuid of the hook currently executing (set at hook PRE, cleared at hook POST).
    // Any scan fired while this is set is stamped with it as thHookRunUuid so the backend
    // (SeleniumHub appAllyScan → hook_run_uuid) can reconcile the scan onto the wrapping test.
    currentHookRunUuid: string | null = null

    constructor(accessibilityConfig: Accessibility, isNonBstackA11y: boolean) {
        super()
        this.name = 'AccessibilityModule'
        this.accessibilityConfig = accessibilityConfig
        AutomationFramework.registerObserver(AutomationFrameworkState.CREATE, HookState.POST, this.onBeforeExecute.bind(this))
        TestFramework.registerObserver(TestFrameworkState.TEST, HookState.PRE, this.onBeforeTest.bind(this))
        TestFramework.registerObserver(TestFrameworkState.TEST, HookState.POST, this.onAfterTest.bind(this))
        // Track the hook window for every hook state the framework supports. PRE captures the
        // hook's run uuid + opens the scan gate; POST clears the uuid so later test-body scans
        // are not mis-stamped as hook scans.
        for (const hookFrameworkState of [TestFrameworkState.BEFORE_ALL, TestFrameworkState.BEFORE_EACH, TestFrameworkState.AFTER_EACH, TestFrameworkState.AFTER_ALL]) {
            TestFramework.registerObserver(hookFrameworkState, HookState.PRE, this.onHookStart.bind(this))
            TestFramework.registerObserver(hookFrameworkState, HookState.POST, this.onHookEnd.bind(this))
        }
        this.accessibility = Boolean(accessibilityConfig)
        const accessibilityOptions = (BrowserstackCLI.getInstance().options as Record<string, unknown>)?.accessibilityOptions as { [key: string]: string | boolean | undefined }
        this.autoScanning = Boolean(accessibilityOptions?.autoScanning ?? true)
        this.scriptInstance = accessibilityScripts
        this.accessibilityMap = new Map()
        this.LOG_DISABLED_SHOWN = new Map()
        this.isAppAccessibility = accessibilityConfig.isAppAccessibility || false
        this.isNonBstackA11y = isNonBstackA11y
    }

    async onHookStart(args: Record<string, unknown>) {
        try {
            const testInstance: TestFrameworkInstance = (args?.instance as TestFrameworkInstance) || TestFramework.getTrackedInstance()
            // KEY_HOOK_ID is stamped on the instance at hook PRE (wdioMochaTestFramework.trackEvent)
            // and is the SAME uuid reported to TestHub as the hook run, so a scan tagged with it can
            // be self-joined onto the wrapping test in BTCER. Capture it FIRST — it needs only the
            // test instance. The automation-framework instance (below) is required solely for the web
            // per-command scan gate; on the app CLI path an explicit performScan() carries the uuid
            // regardless, and autoInstance is not always resolvable at hook time — so gating the
            // capture on autoInstance would silently drop app hook-scan stamping.
            const hookRunUuid = testInstance ? (TestFramework.getState(testInstance, TestFrameworkConstants.KEY_HOOK_ID) as string | undefined) : undefined
            this.currentHookRunUuid = hookRunUuid || null

            const autoInstance: AutomationFrameworkInstance = AutomationFramework.getTrackedInstance()
            if (!testInstance || !autoInstance) {
                return
            }
            const sessionId = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_FRAMEWORK_SESSION_ID)

            if (!this.accessibility) {
                return
            }
            // Open the scan gate for the hook window so DOM-changing commands issued inside
            // before/beforeEach/afterEach/after hooks trigger scans (web per-command path). The
            // following onBeforeTest re-computes the per-test gate, so this only affects the hook.
            if (this.autoScanning && sessionId !== undefined && sessionId !== null) {
                this.accessibilityMap.set(sessionId, true)
            }
        } catch (error) {
            this.logger.error(`Exception in accessibility onHookStart: ${error}`)
        }
    }

    async onHookEnd() {
        // Hook finished: subsequent (test-body) scans must not be stamped with the hook uuid.
        this.currentHookRunUuid = null
    }

    /**
     * browser.reloadSession() hands the worker a NEW session id while the driver object, the
     * wrapped commands and the currently running test all stay exactly the same. The scan gate
     * is keyed on the session id, so the entry registered for the old id is orphaned the moment
     * the reload lands: every command issued for the rest of that test looks up a key that does
     * not exist and is silently not scanned. Nothing re-registers until the NEXT onBeforeTest,
     * so a test that reloads mid-way loses all coverage after the reload.
     *
     * Migrating the entry rather than re-deriving it preserves whatever the gate currently says,
     * including a stopA11yScanning() the user called before reloading.
     */
    onSessionReload(oldSessionId: string, newSessionId: string) {
        try {
            if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) {
                return
            }

            if (this.accessibilityMap.has(oldSessionId)) {
                this.accessibilityMap.set(newSessionId, this.accessibilityMap.get(oldSessionId) as boolean)
                this.accessibilityMap.delete(oldSessionId)
                this.logger.debug(`Accessibility scan gate migrated across session reload to ${newSessionId}`)
            }
            if (this.LOG_DISABLED_SHOWN.has(oldSessionId)) {
                this.LOG_DISABLED_SHOWN.set(newSessionId, this.LOG_DISABLED_SHOWN.get(oldSessionId) as boolean)
                this.LOG_DISABLED_SHOWN.delete(oldSessionId)
            }
        } catch (error) {
            this.logger.error(`Exception in accessibility onSessionReload: ${error}`)
        }
    }

    /**
     * The session id as of RIGHT NOW, read from framework state rather than captured.
     *
     * Anything installed on the driver — the scanning toggles, the results getters — outlives the
     * session it was created in, because `browser.reloadSession()` swaps the session underneath a
     * driver object that carries on unchanged. A captured id makes those closures address a
     * session that has ended, while `commandWrapper` re-reads state and addresses the live one.
     */
    private currentSessionId(): string | undefined {
        try {
            const autoInstance: AutomationFrameworkInstance = AutomationFramework.getTrackedInstance()
            return autoInstance
                ? AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_FRAMEWORK_SESSION_ID) as string
                : undefined
        } catch {
            return undefined
        }
    }

    async onBeforeExecute() {
        try {
            const autoInstance: AutomationFrameworkInstance = AutomationFramework.getTrackedInstance()

            if (!autoInstance) {
                this.logger.debug('No tracked instances found!')
                return
            }

            const browser = AutomationFramework.getDriver(autoInstance) as WebdriverIO.Browser

            if (!browser) {
                this.logger.debug('No browser instance found for command wrapping')
                return
            }

            const isBrowserstackSession = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_IS_BROWSERSTACK_HUB)
            const browserCaps = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_CAPABILITIES)
            const inputCaps = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_INPUT_CAPABILITIES)
            const platformA11yMeta = {
                browser_name: browserCaps.browserName,
                browser_version: browserCaps?.browserVersion || 'latest',
                platform_name: browserCaps?.platformName,
                platform_version: this.getCapability(browserCaps, 'appium:platformVersion', 'platformVersion'),
            }

            // App Automate sessions must run the app-accessibility flow, not the
            // Chrome-only web path. The binary's isAppAccessibility flag is not
            // guaranteed to be set on the CLI path, so derive app-ness from caps the
            // same way the classic flow does (service._isAppAutomate).
            if (this.isAppAutomateSession(inputCaps, browserCaps)) {
                this.isAppAccessibility = true
            }

            if (this.isAppAccessibility) {
                this.accessibility = validateCapsWithAppA11y(platformA11yMeta)
            } else {
                const device = this.getCapability(inputCaps, 'deviceName')
                const chromeOptions = this.getCapability(inputCaps, 'goog:chromeOptions')
                this.accessibility = validateCapsWithA11y(device, platformA11yMeta, chromeOptions)
            }

            //patching getA11yResultsSummary
            (browser as WebdriverIO.Browser).getAccessibilityResultsSummary = async () => {
                if (this.isAppAccessibility) {
                    return await getAppA11yResultsSummary(true, browser, this.currentTestName, isBrowserstackSession, this.accessibility, this.currentSessionId())
                }
                return await this.getA11yResultsSummary(browser)
            }

            //patching getA11yResults
            (browser as WebdriverIO.Browser).getAccessibilityResults = async () => {
                if (this.isAppAccessibility) {
                    return await getAppA11yResults(true, browser, this.currentTestName, isBrowserstackSession, this.accessibility, this.currentSessionId())
                }
                return await this.getA11yResults(browser)
            }

            //patching performScan
            (browser as WebdriverIO.Browser).performScan = async () => {
                if (!this.accessibility && !this.isAppAccessibility){
                    return
                }
                // If invoked from inside a hook, currentHookRunUuid stamps the scan for the hook.
                return await this.performScanCli(browser, undefined, this.currentHookRunUuid, !this.currentHookRunUuid && !this.currentTestName)
            }

            (browser as WebdriverIO.Browser).startA11yScanning = async () => {
                if (!this.accessibility && !this.isAppAccessibility){
                    return
                }
                this.logger.warn('Accessibility scanning cannot be started from outside the test')
            }

            (browser as WebdriverIO.Browser).stopA11yScanning = async () => {
                if (!this.accessibility && !this.isAppAccessibility){
                    return
                }
                this.logger.warn('Accessibility scanning cannot be stopped from outside the test')
            }

            if (!this.accessibility) {
                this.logger.info('Accessibility automation is disabled for this session.')
                return
            }

            // Per-command wrapping (overwriteCommand) drives auto-scanning on both the web and the
            // App Automate a11y flows. App sessions were previously skipped (isAppAccessibility gate)
            // out of a concern that appium drivers don't register these commands, so overwriteCommand
            // would throw and abort onBeforeExecute — but that skip disabled per-command auto-scan for
            // app entirely, so app a11y scans only fired via an explicit performScan()/lifecycle.
            // Instead, wrap for every flow and guard EACH overwriteCommand individually: a command the
            // driver doesn't register just skips (logged) rather than aborting the whole wrap loop, so
            // the commands appium DOES register (click, setValue, ...) still auto-scan on app.
            if ('overwriteCommand' in browser && Array.isArray(this.scriptInstance.commandsToWrap)) {
                this.scriptInstance.commandsToWrap
                    .filter((command) => command.name && command.class)
                    .forEach((command) => {
                        try {
                            browser.overwriteCommand(
                                // @ts-expect-error fix type
                                command.name,
                                this.commandWrapper.bind(this, command),
                                command.class === 'Element'
                            )
                        } catch (wrapError) {
                            this.logger.debug(`Skipping command wrap for ${command.name}: ${wrapError}`)
                        }
                    })
            }

            // WDIO's config-level hooks (before, beforeSuite) run before any test or framework
            // hook exists, so onHookStart — which returns early without a test instance — cannot
            // cover them, and driver commands issued there went unscanned. Every validation
            // onHookStart applies still applies here: an a11y-capable session (returned above)
            // and autoScanning. The include/exclude tag filter is the one exception — it matches
            // on suite and test titles, and in this window neither exists yet. onBeforeTest
            // re-computes the per-test gate, tags included, so this only affects the window.
            const preTestSessionId = this.currentSessionId()
            if (this.autoScanning && preTestSessionId !== undefined && preTestSessionId !== null) {
                this.accessibilityMap.set(preTestSessionId, true)
                this.logger.debug('Accessibility scan gate opened ahead of the first test')
            }

        } catch (error) {
            this.logger.error(`Error in onBeforeExecute: ${error}`)
        }
    }

    private async commandWrapper(command: Command, originFunction: Function, ...args: unknown[]) {
        try {
            const autoInstance: AutomationFrameworkInstance = AutomationFramework.getTrackedInstance()
            const sessionId = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_FRAMEWORK_SESSION_ID)
            // Check if accessibility is still enabled for this session
            if (sessionId && this.accessibilityMap.get(sessionId)) {
                const browser = AutomationFramework.getDriver(autoInstance) as WebdriverIO.Browser

                // Perform accessibility scan before command if script is available
                if (
                    !command.name.includes('execute') ||
                    !this.shouldPatchExecuteScript(args.length ? args[0] as string : null)
                ) {
                    try {
                        // Parentless only when nothing can own the scan: no framework hook run
                        // (reported to TRA, keeps its test uuid) and no test running. The wrapper
                        // never knows which hook it is in, and does not need to.
                        const hasNoParent = !this.currentHookRunUuid && !this.currentTestName
                        await this.performScanCli(browser, command.name, this.currentHookRunUuid, hasNoParent)
                        this.logger.debug(`Accessibility scan performed after ${command.name} command`)
                    } catch (scanError) {
                        this.logger.debug(`Error performing accessibility scan after ${command.name}: ${scanError}`)
                    }
                }
            }

            // Execute the original command
            const result = await originFunction(...args)

            return result

        } catch (error) {
            this.logger.error(`Error in commandWrapper for ${command.name}: ${error}`)
            // Still execute the original command even if accessibility scan fails
            return await originFunction(...args)
        }
    }

    async onBeforeTest(args: Record<string, unknown>) {
        try {
            this.logger.debug('Accessibility before test hook. Starting accessibility scan for this test case.')
            const suiteTitle = (typeof args.suiteTitle === 'string' ? args.suiteTitle : '') || ''
            const test = (args.test && typeof args.test === 'object' ? args.test as { title?: string } : {}) || {}

            this.currentTestName = test.title || null
            const autoInstance: AutomationFrameworkInstance = AutomationFramework.getTrackedInstance()
            const testInstance: TestFrameworkInstance = TestFramework.getTrackedInstance()

            const sessionId = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_FRAMEWORK_SESSION_ID)
            const accessibilityOptions = this.config.accessibilityOptions
            const shouldScanTest = this.autoScanning && shouldScanTestForAccessibility(suiteTitle, test.title || '', accessibilityOptions as Record<string, string> | undefined) && this.accessibility

            this.accessibilityMap.set(sessionId, shouldScanTest)

            // Create test metadata similar to accessibility-handler
            const testIdentifier = String(testInstance.getContext().getId())
            this.testMetadata[testIdentifier] = {
                scanTestForAccessibility: shouldScanTest,
                accessibilityScanStarted: shouldScanTest
            }

            const browser = AutomationFramework.getDriver(autoInstance) as WebdriverIO.Browser

            (browser as WebdriverIO.Browser).startA11yScanning = async () => {
                if (!this.accessibility && !this.isAppAccessibility){
                    return
                }
                // Resolved at call time: a reload mid-test moves the gate to a new key, and
                // writing to the captured one would leave the user's start/stop with no effect.
                this.accessibilityMap.set(this.currentSessionId() ?? sessionId, true)
                this.testMetadata[testIdentifier] = {
                    scanTestForAccessibility : true,
                    accessibilityScanStarted : true
                }
                TestFramework.setState(testInstance, `accessibility_metadata_${testIdentifier}`, this.testMetadata[testIdentifier])
                await this._setAnnotation('Accessibility scanning has started')
            }

            (browser as WebdriverIO.Browser).stopA11yScanning = async () => {
                if (!this.accessibility && !this.isAppAccessibility){
                    return
                }
                this.accessibilityMap.set(this.currentSessionId() ?? sessionId, false)
                await this._setAnnotation('Accessibility scanning has stopped')
            }

            (browser as WebdriverIO.Browser).performScan = async () => {
                if (!this.accessibility && !this.isAppAccessibility){
                    return
                }
                const results = await this.performScanCli(browser, undefined, this.currentHookRunUuid)
                if (results){
                    const testIdentifier = String(testInstance.getContext().getId())
                    this.testMetadata[testIdentifier] = {
                        scanTestForAccessibility : true,
                        accessibilityScanStarted : true
                    }
                    TestFramework.setState(testInstance, `accessibility_metadata_${testIdentifier}`, this.testMetadata[testIdentifier])
                    await this._setAnnotation('Accessibility scanning was triggered manually')

                }
                return results
            }

            // Store test metadata in test instance
            TestFramework.setState(testInstance, `accessibility_metadata_${testIdentifier}`, this.testMetadata[testIdentifier])

            // Log if accessibility scan is enabled for this test
            if (shouldScanTest) {
                this.logger.info('Accessibility test case execution has started.')
            } else if (!this.LOG_DISABLED_SHOWN.get(sessionId)) {
                this.logger.info('Accessibility scanning disabled for this test case.')
                this.LOG_DISABLED_SHOWN.set(sessionId, true)
            }

        } catch (error) {
            this.logger.error(`Exception in starting accessibility automation scan for this test case: ${error}`)
        }
    }

    async onAfterTest() {
        this.logger.debug('Accessibility after test hook. Before sending test stop event')

        try {

            const autoInstance: AutomationFrameworkInstance = AutomationFramework.getTrackedInstance()
            const testInstance: TestFrameworkInstance = TestFramework.getTrackedInstance()
            const sessionId = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_FRAMEWORK_SESSION_ID)

            if (!autoInstance || !testInstance) {
                this.logger.error('No tracked instances found for accessibility after test')
                this.currentTestName = null
                return
            }

            // Get test metadata that was stored in onBeforeTest
            const testIdentifier = String(testInstance.getContext().getId())
            const testMetadata = testInstance.getData(`accessibility_metadata_${testIdentifier}`) as { [key: string]: unknown; }

            if (!testMetadata) {
                this.logger.debug('No accessibility metadata found for this test')
                return
            }

            const { accessibilityScanStarted, scanTestForAccessibility } = testMetadata
            if (!accessibilityScanStarted) {
                this.logger.debug('Accessibility scan was not started for this test')
                return
            }

            if (scanTestForAccessibility) {
                this.logger.info('Automate test case execution has ended. Processing for accessibility testing is underway.')

                // Get the driver for sending test stop event
                const browser = AutomationFramework.getDriver(autoInstance) as WebdriverIO.Browser

                if (browser) {
                    let dataForExtension = {
                        'thTestRunUuid': process.env.TEST_ANALYTICS_ID,
                        'thBuildUuid': process.env.BROWSERSTACK_TESTHUB_UUID,
                        'thJwtToken': process.env.BROWSERSTACK_TESTHUB_JWT
                    }
                    const driverExecuteParams = await this.getDriverExecuteParams()
                    dataForExtension = { ...dataForExtension, ...driverExecuteParams }

                    // final scan and saving the results
                    await this.sendTestStopEvent(browser, dataForExtension)
                    this.logger.info('Accessibility testing for this test case has ended.')
                } else {
                    this.logger.warn('No driver found to send accessibility test stop event')
                }
                this.accessibilityMap.delete(sessionId)

                // Clean up test metadata
                TestFramework.setState(testInstance, `accessibility_metadata_${testIdentifier}`, null)
            }

        } catch (error) {
            this.logger.error(`Accessibility results could not be processed for the test case. Error: ${error}`)
        } finally {
            this.currentTestName = null
            this.logger.debug('[AccessibilityModule] Current test name cleared after test completion')
        }
    }

    private shouldPatchExecuteScript(script: string | null): boolean {
        if (!script || typeof script !== 'string') {
            return true
        }

        return (
            script.toLowerCase().indexOf('browserstack_executor') !== -1 ||
            script.toLowerCase().indexOf('browserstack_accessibility_automation_script') !== -1
        )
    }

    private getCapability(capabilities: WebdriverIO.Capabilities, key: string, legacyKey = '') {

        if (key === 'deviceName') {
            if ((capabilities as WebdriverIO.Capabilities)['bstack:options'] && (capabilities as WebdriverIO.Capabilities)['bstack:options']?.deviceName) {
                return (capabilities as WebdriverIO.Capabilities)['bstack:options']?.deviceName
            } else if ((capabilities as WebdriverIO.Capabilities)['bstack:options'] && (capabilities as WebdriverIO.Capabilities)['bstack:options']?.device) {
                return (capabilities as WebdriverIO.Capabilities)['bstack:options']?.device
            } else if ((capabilities as WebdriverIO.Capabilities)['appium:deviceName']) {
                return (capabilities as WebdriverIO.Capabilities)['appium:deviceName']
            }
        } else if (key === 'goog:chromeOptions' && (capabilities as WebdriverIO.Capabilities)['goog:chromeOptions']) {
            return (capabilities as WebdriverIO.Capabilities)['goog:chromeOptions']
        } else {
            const bstackOptions = (capabilities as WebdriverIO.Capabilities)['bstack:options']
            if (bstackOptions && Object.prototype.hasOwnProperty.call(bstackOptions, key)) {
                return (bstackOptions as Record<string, unknown>)[key]
            } else if ((capabilities as WebdriverIO.Capabilities)[legacyKey as keyof WebdriverIO.Capabilities]) {
                return (capabilities as WebdriverIO.Capabilities)[legacyKey as keyof WebdriverIO.Capabilities]
            }
        }

    }

    // Mirrors service._isAppAutomate: an App Automate session is identified by the
    // presence of an app capability (appium:app / appium:options.app).
    private isAppAutomateSession(inputCaps?: WebdriverIO.Capabilities, browserCaps?: WebdriverIO.Capabilities): boolean {
        for (const caps of [inputCaps, browserCaps]) {
            const c = (caps ?? {}) as Record<string, unknown>
            if (c['appium:app'] || (c['appium:options'] as { app?: unknown } | undefined)?.app) {
                return true
            }
        }
        return false
    }

    private async performScanCli(
        browser: WebdriverIO.Browser | WebdriverIO.MultiRemoteBrowser,
        commandName?: string,
        hookRunUuid?: string | null,
        isGlobalHook?: boolean
    ): Promise<Record<string, unknown> | undefined> {
        return await PerformanceTester.measureWrapper(
            PERFORMANCE_SDK_EVENTS.A11Y_EVENTS.PERFORM_SCAN,
            async () => {
                try {
                    if (!this.accessibility) {
                        this.logger.debug('Not an Accessibility Automation session.')
                        return
                    }
                    if (this.isAppAccessibility) {
                        const testName=this.currentTestName || undefined
                        const results: unknown = await (browser as WebdriverIO.Browser).execute(
                            formatString(this.scriptInstance.performScan, JSON.stringify(_getParamsForAppAccessibility(commandName, testName, hookRunUuid, isGlobalHook))) as string,
                            {}
                        )
                        BStackLogger.debug(util.format(results as string))
                        return (results as Record<string, unknown> | undefined)
                    }
                    const results = await (browser as WebdriverIO.Browser).executeAsync(
                        this.scriptInstance.performScan as string,
                        { 'method': commandName || '' }
                    )
                    return (results as Record<string, unknown> | undefined)
                } catch (err: unknown) {
                    this.logger.error('Accessibility Scan could not be performed : ' + err)
                    return
                }
            },
            { command: commandName }
        )()
    }

    private async sendTestStopEvent(browser: WebdriverIO.Browser, dataForExtension: Record<string, unknown>) {
        try {
            const autoInstance: AutomationFrameworkInstance = AutomationFramework.getTrackedInstance()
            const sessionId = AutomationFramework.getState(autoInstance, AutomationFrameworkConstants.KEY_FRAMEWORK_SESSION_ID)
            if (!this.accessibility) {
                this.logger.debug('Not an Accessibility Automation session.')
                return
            }

            if (this.accessibilityMap.get(sessionId)) {
                this.logger.debug('Performing scan before saving results')
                await this.performScanCli(browser)
            }

            if (this.isAppAccessibility) {
                return
            }

            await PerformanceTester.measureWrapper(PERFORMANCE_SDK_EVENTS.A11Y_EVENTS.SAVE_RESULTS, async () => {
                const results: unknown = await (browser as WebdriverIO.Browser).executeAsync(accessibilityScripts.saveTestResults as string, dataForExtension)
                this.logger.debug(`save results : ${util.format(results as string)}`)
            })()
        } catch (error) {
            this.logger.error(`Error while sending test stop event: ${error}`)
        }
    }

    async getA11yResults(browser: WebdriverIO.Browser): Promise<Array<Record<string, unknown>>> {
        return await PerformanceTester.measureWrapper(
            PERFORMANCE_SDK_EVENTS.A11Y_EVENTS.GET_RESULTS,
            async () => {
                try {
                    if (!this.accessibility) {
                        this.logger.debug('Not an Accessibility Automation session.')
                        return
                    }
                    this.logger.debug('Performing scan before getting results')
                    await this.performScanCli(browser)
                    const results: Array<Record<string, unknown>> = await (browser as WebdriverIO.Browser).executeAsync(this.scriptInstance.getResults as string)
                    return results
                } catch (error: unknown) {
                    this.logger.error('No accessibility results were found.')
                    this.logger.debug(`getA11yResults Failed. Error: ${error}`)
                    return []
                }
            }
        )()
    }

    async getA11yResultsSummary(browser: WebdriverIO.Browser): Promise<Record<string, unknown>> {
        return await PerformanceTester.measureWrapper(
            PERFORMANCE_SDK_EVENTS.A11Y_EVENTS.GET_RESULTS_SUMMARY,
            async () => {
                try {
                    if (!this.accessibility) {
                        this.logger.debug('Not an Accessibility Automation session.')
                        return
                    }
                    this.logger.debug('Performing scan before getting results summary')
                    await this.performScanCli(browser)
                    const summaryResults: Record<string, unknown> = await (browser as WebdriverIO.Browser).executeAsync(this.scriptInstance.getResultsSummary as string)
                    return summaryResults
                } catch {
                    this.logger.error('No accessibility summary was found.')
                    return {}
                }
            }
        )()
    }

    async getDriverExecuteParams(): Promise<Record<string, unknown>> {
        const payload: Omit<FetchDriverExecuteParamsEventRequest, 'binSessionId'> = {
            product: 'accessibility',
            scriptName: 'saveResults'
        }
        const response: FetchDriverExecuteParamsEventResponse = await GrpcClient.getInstance().fetchDriverExecuteParamsEvent(payload)
        if (response.success) {
            return response.accessibilityExecuteParams ? JSON.parse(Buffer.from(response.accessibilityExecuteParams).toString('utf8')) : {}
        }
        this.logger.error(`Failed to fetch driver execute params: ${response.error || 'Unknown error'}`)
        return {}
    }

    public async _setAnnotation(message: string) {
        const autoInstance: AutomationFrameworkInstance = AutomationFramework.getTrackedInstance()
        const browser = AutomationFramework.getDriver(autoInstance) as WebdriverIO.Browser

        if (this.accessibility && isBrowserstackSession(browser)) {
            await (browser as WebdriverIO.Browser).execute(`browserstack_executor: ${JSON.stringify({
                action: 'annotate',
                arguments: {
                    data: message,
                    level: 'info'
                }
            })}`)
        }
    }

}
