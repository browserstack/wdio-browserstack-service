/// <reference path="../../@types/bstack-service-types.d.ts" />
import BaseModule from './baseModule.js'
import { BStackLogger } from '../cliLogger.js'
import TestFramework from '../frameworks/testFramework.js'
import AutomationFramework from '../frameworks/automationFramework.js'
import type AutomationFrameworkInstance from '../instances/automationFrameworkInstance.js'
import type TestFrameworkInstance from '../instances/testFrameworkInstance.js'
import { AutomationFrameworkState } from '../states/automationFrameworkState.js'
import { HookState } from '../states/hookState.js'
import { TestFrameworkState } from '../states/testFrameworkState.js'
import { TestFrameworkConstants } from '../frameworks/constants/testFrameworkConstants.js'
import { CLIUtils } from '../cliUtils.js'
import WdioMochaTestFramework from '../frameworks/wdioMochaTestFramework.js'
import { mergeIntoTags, parseCommaSeparatedValues, getCurrentMochaHookWindow } from '../../customTags.js'
import type { CustomMetadata } from '../../customTags.js'

/**
 * CustomTagsModule — CLI/gRPC path registration for `browser.setCustomTags`.
 *
 * Mirrors AccessibilityModule: registers the browser method in onBeforeExecute()
 * (observer-bound to AutomationFrameworkState.CREATE / HookState.POST), instantiated
 * from BrowserstackCLI.loadModules() whenever the binary is up.
 *
 * The per-test custom_metadata is merged directly into the tracked
 * TestFrameworkInstance map under KEY_CUSTOM_TAGS ('custom_metadata'). That whole
 * map is serialized verbatim into event_json (testHubModule.sendTestFrameworkEvent),
 * so the binary reads it as event.custom_metadata. The instance is created fresh
 * per test, so per-instance merge gives test-scoped union/dedupe; the binary is a
 * strict pass-through and does NOT consolidate across events.
 */
export default class CustomTagsModule extends BaseModule {

    logger = BStackLogger
    name: string
    static MODULE_NAME = 'CustomTagsModule'

    /**
     * Tags set before a per-test context exists — e.g. from a `beforeEach` hook, which
     * WDIO runs BEFORE `beforeTest` tracks the test instance. Buffered here and flushed
     * into the test at test start (onBeforeTest), then reset per-test, so hook-set tags
     * land on the test (parity with Java @Before). Process-local (one module per worker)
     * and Mocha runs tests serially, so a plain object is safe.
     */
    private pendingTestLevelTags: CustomMetadata = {}

    constructor() {
        super()
        this.name = 'CustomTagsModule'
        AutomationFramework.registerObserver(AutomationFrameworkState.CREATE, HookState.POST, this.onBeforeExecute.bind(this))
        TestFramework.registerObserver(TestFrameworkState.TEST, HookState.PRE, this.onBeforeTest.bind(this))
    }

    getModuleName() {
        return CustomTagsModule.MODULE_NAME
    }

    async onBeforeExecute() {
        try {
            const autoInstance: AutomationFrameworkInstance = AutomationFramework.getTrackedInstance()
            if (!autoInstance) {
                this.logger.debug('CustomTagsModule: No tracked automation instance found!')
                return
            }

            const browser = AutomationFramework.getDriver(autoInstance) as WebdriverIO.Browser
            if (!browser) {
                this.logger.debug('CustomTagsModule: No browser instance found for setCustomTags registration')
                return
            }

            (browser as WebdriverIO.Browser).setCustomTags = async (key: string, value: string): Promise<void> => {
                try {
                    if (!key || !value) {
                        this.logger.warn('setCustomTags: key and value are required; ignoring call')
                        return
                    }

                    const values = parseCommaSeparatedValues(value)
                    if (values.length === 0) {
                        this.logger.warn(`setCustomTags: no usable values parsed from "${value}"; ignoring call`)
                        return
                    }

                    // Route by the open Mocha hook window (recorded by the service layer —
                    // the CLI framework never sees Mocha's beforeEach/afterEach):
                    //   - before-each / before-all → the tag belongs to the UPCOMING test.
                    //     The tracked instance is absent (first test) or still the PREVIOUS
                    //     test here, so buffer and flush at test start (onBeforeTest).
                    //   - after-each / after-all / in-test → the CURRENT tracked test. Its
                    //     TestRunFinished send is deferred past the after-each window
                    //     (TestHubModule), so late merges still make the payload.
                    const hookWindow = getCurrentMochaHookWindow()
                    const isPreTestWindow = hookWindow === 'before_each' || hookWindow === 'before_all'
                    const testInstance: TestFrameworkInstance = TestFramework.getTrackedInstance()
                    if (!testInstance || isPreTestWindow) {
                        mergeIntoTags(this.pendingTestLevelTags, key, values)
                        this.logger.debug(`setCustomTags: buffered pre-test tag key=${key} values=${JSON.stringify(values)} (window=${hookWindow ?? 'none'}; will flush at test start)`)
                        return
                    }

                    // Merge into the per-test instance map (test-scoped accumulator).
                    const existing = (TestFramework.getState(testInstance, TestFrameworkConstants.KEY_CUSTOM_TAGS) as CustomMetadata) || {}
                    mergeIntoTags(existing, key, values)
                    testInstance.updateMultipleEntries({
                        [TestFrameworkConstants.KEY_CUSTOM_TAGS]: existing
                    })

                    // Hook-level: if a hook is currently active, also stamp custom_metadata
                    // onto the active hook so binary reads hook.custom_metadata.
                    this.applyToActiveHook(testInstance, key, values)

                    this.logger.debug(`setCustomTags: merged key=${key} values=${JSON.stringify(values)}`)
                } catch (error) {
                    this.logger.warn(`setCustomTags: error while recording custom tags: ${error}`)
                }
            }
        } catch (error) {
            this.logger.error(`Error in CustomTagsModule.onBeforeExecute: ${error}`)
        }
    }

    /**
     * At each test start (TEST/PRE — after beforeTest tracks the instance), flush any
     * tags buffered before the test had a context (e.g. set in a `beforeEach` hook — see
     * the setCustomTags closure) into the tracked instance's custom_metadata via the SAME
     * merge path as explicit setCustomTags, then reset the buffer for the next test — so
     * hook-set tags union onto the test (parity with Java @Before).
     */
    async onBeforeTest(args: Record<string, unknown>) {
        try {
            // Prefer the tracked instance (the SAME one the explicit setCustomTags closure
            // reads/writes) so buffered and programmatic tags all union.
            const testInstance = TestFramework.getTrackedInstance() || (args.instance as TestFrameworkInstance)
            if (!testInstance) {
                return
            }

            // Flush tags buffered before this test had a context (e.g. from beforeEach).
            if (Object.keys(this.pendingTestLevelTags).length > 0) {
                const buffered = (TestFramework.getState(testInstance, TestFrameworkConstants.KEY_CUSTOM_TAGS) as CustomMetadata) || {}
                for (const [k, entry] of Object.entries(this.pendingTestLevelTags)) {
                    mergeIntoTags(buffered, k, entry.values)
                }
                testInstance.updateMultipleEntries({
                    [TestFrameworkConstants.KEY_CUSTOM_TAGS]: buffered
                })
                this.logger.debug(`setCustomTags: flushed buffered pre-test tags ${JSON.stringify(Object.keys(this.pendingTestLevelTags))} into test`)
                this.pendingTestLevelTags = {}
            }
        } catch (error) {
            this.logger.debug(`setCustomTags: error flushing buffered pre-test tags: ${error}`)
        }
    }

    /**
     * If the test framework is currently inside a hook, merge custom_metadata onto
     * the last-started hook record so the binary receives hook.custom_metadata.
     * Best-effort: silently no-ops when no active hook is resolvable.
     */
    private applyToActiveHook(testInstance: TestFrameworkInstance, key: string, values: string[]) {
        try {
            const currentState = testInstance.getCurrentTestState().toString()
            if (!CLIUtils.matchHookRegex(currentState)) {
                return
            }
            const hook = WdioMochaTestFramework.lastActiveHook(testInstance, WdioMochaTestFramework.KEY_HOOK_LAST_STARTED)
            if (!hook) {
                return
            }
            const hookTags = (hook[TestFrameworkConstants.KEY_CUSTOM_TAGS] as CustomMetadata) || {}
            mergeIntoTags(hookTags, key, values)
            hook[TestFrameworkConstants.KEY_CUSTOM_TAGS] = hookTags
        } catch (error) {
            this.logger.debug(`setCustomTags: could not apply to active hook: ${error}`)
        }
    }
}
