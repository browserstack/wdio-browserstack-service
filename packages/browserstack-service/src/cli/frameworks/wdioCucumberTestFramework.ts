import { v4 as uuidv4 } from 'uuid'
import path from 'node:path'

import TestFramework from './testFramework.js'
import { TestFrameworkState } from '../states/testFrameworkState.js'
import { HookState } from '../states/hookState.js'
import TestFrameworkInstance from '../instances/testFrameworkInstance.js'
import TrackedInstance from '../instances/trackedInstance.js'
import { CLIUtils } from '../cliUtils.js'
import { TestFrameworkConstants } from './constants/testFrameworkConstants.js'
import { BStackLogger as logger } from '../cliLogger.js'
import { TEST_ANALYTICS_ID } from '../../constants.js'
import { getScenarioExamples, removeAnsiColors } from '../../util.js'

import type { Frameworks } from '@wdio/types'
import type { CucumberHook, Feature, FeatureChild, ITestCaseHookParameter, Pickle, Scenario, Step } from '../../cucumber-types.js'

/**
 * Wire keys the binary's WebdriverIO-cucumber module consumes that have no entry in
 * TestFrameworkConstants. Kept local rather than appended to that file, which mocha shares.
 */
const KEY_TEST_DURATION = 'test_duration'
const KEY_BDD_META_INFO = 'bdd_meta_info'
const KEY_TEST_SKIPPED_CASCADE = 'test_skipped_cascade'
const KEY_HOOK_SCOPE = 'hook_scope'
const KEY_HOOK_RETRIES = 'hook_retries'
const KEY_HOOK_DURATION = 'hook_duration'

type CucumberHookType = 'BEFORE_ALL' | 'AFTER_ALL' | 'BEFORE_EACH' | 'AFTER_EACH'

const HOOK_STATES: Record<CucumberHookType, State> = {
    BEFORE_ALL: TestFrameworkState.BEFORE_ALL,
    AFTER_ALL: TestFrameworkState.AFTER_ALL,
    BEFORE_EACH: TestFrameworkState.BEFORE_EACH,
    AFTER_EACH: TestFrameworkState.AFTER_EACH,
}

interface StepMeta {
    id: string
    text: string
    keyword: string
    started_at?: string
    finished_at?: string
    result?: string
    duration?: unknown
    failure?: string
}

/**
 * CLI test framework for `framework: 'cucumber'` under WebdriverIO.
 *
 * Extends the BASE TestFramework, never WdioMochaTestFramework: WDIO does not call
 * `beforeTest`/`afterTest` or deliver titled hooks for cucumber, so mocha's INIT_TEST / TEST /
 * hook-boundary semantics have no source here.
 *
 * A scenario raises TEST/PRE at `beforeScenario` and TEST/POST at `afterScenario`. That is not a
 * preference: the binary's WDIO language index dispatches only on `TEST` and `^(BEFORE_|AFTER_)`,
 * so an additional state would be silently discarded on the far side.
 */
export default class WdioCucumberTestFramework extends TestFramework {
    static KEY_HOOK_LAST_STARTED = 'test_hook_last_started'
    static KEY_HOOK_LAST_FINISHED = 'test_hook_last_finished'

    /**
     * The bookkeeping hook classification is derived from. A cucumber hook invocation carries no
     * title and `BeforeAll`/`AfterAll` pass no hook object at all, so `util.ts → getHookType()`
     * (Mocha quoted-title matching) can only return 'unknown' or throw on the property access.
     *
     * `stepDepth` is deliberately NOT reset per scenario. Legacy pushes to and pops from
     * `_cucumberData.steps` with no per-scenario reset, so a step that never reaches `afterStep`
     * leaves the depth above zero for the rest of the run and every later AFTER_EACH is
     * classified null and dropped. That is v8 behaviour and therefore the parity target
     * (pre-existing-bugs PB-V8-1); the per-scenario reset exists only on the v9 line.
     */
    private cucumberData: {
        feature?: Feature
        uri?: string
        scenario?: Pickle
        scenariosStarted: boolean
        stepsStarted: boolean
        stepDepth: number
    } = { scenariosStarted: false, stepsStarted: false, stepDepth: 0 }

    /**
     * Steps of the scenario in flight, mirroring legacy's per-scenario `_tests[uniqueId].steps`.
     * Re-allocated (never cleared in place) at each scenario start, so a payload already built
     * from the previous scenario cannot observe this one's steps through a retained reference.
     */
    private scenarioSteps: StepMeta[] = []

    /** The hook started and not yet finished on this worker — legacy's `_currentHook`. */
    private openHook: { key: string, hookId: string } | null = null

    /**
     * Set when a hook finish arrived with no recorded start. Legacy throws at that point and the
     * wrapper swallows it, which drops the HookRunFinished *and* the BEFORE_ALL cascade in the
     * same call; this flag reproduces the second half.
     */
    private lastHookFinishOrphaned = false

    constructor(testFrameworks: string[], testFrameworkVersions: Record<string, string>, binSessionId: string) {
        super(testFrameworks, testFrameworkVersions, binSessionId)
        logger.debug('WdioCucumberTestFramework: constructed')
    }

    /**
     * Feature bookkeeping. Raises no state — cucumber has no feature-level wire event, and
     * `beforeSuite`/`afterSuite` are not part of its WDIO surface.
     */
    onFeatureStart(uri: string, feature: Feature) {
        logger.debug(`WdioCucumberTestFramework.onFeatureStart: uri=${uri} feature=${feature?.name}`)
        this.cucumberData.scenariosStarted = false
        this.cucumberData.feature = feature
        this.cucumberData.uri = uri
    }

    /** Step bookkeeping. Steps travel inside the scenario payload's BDD meta, never as events. */
    onStepStart(step: Frameworks.PickleStep) {
        this.cucumberData.stepsStarted = true
        this.cucumberData.stepDepth++
        this.scenarioSteps.push({
            id: step.id,
            text: step.text,
            keyword: step.keyword,
            started_at: (new Date()).toISOString(),
        })
    }

    onStepEnd(step: Frameworks.PickleStep, result: Frameworks.PickleResult) {
        // Math.max mirrors Array.pop() on an empty array, which legacy relies on.
        this.cucumberData.stepDepth = Math.max(0, this.cucumberData.stepDepth - 1)
        const stepMeta = this.scenarioSteps.find(item => item.id === step.id)
        if (!stepMeta) {
            return
        }
        stepMeta.finished_at = (new Date()).toISOString()
        stepMeta.result = result.passed ? 'PASSED' : 'FAILED'
        stepMeta.duration = result.duration
        if (result.error) {
            stepMeta.failure = removeAnsiColors(result.error)
        }
    }

    /**
     * Classify a cucumber hook invocation from the bookkeeping state — legacy's
     * `getCucumberHookType()` algorithm.
     *
     * Returns null for a step-scoped hook (`BeforeStep`/`AfterStep`), which is never reported;
     * reporting one would change the dashboard hook count.
     */
    classifyHookType(test: CucumberHook | undefined): CucumberHookType | null {
        if (!test) {
            return this.cucumberData.scenariosStarted ? 'AFTER_ALL' : 'BEFORE_ALL'
        }
        if (!this.cucumberData.stepsStarted) {
            return 'BEFORE_EACH'
        }
        if (this.cucumberData.stepDepth > 0) {
            return null
        }
        return 'AFTER_EACH'
    }

    /** The TestFrameworkState a cucumber hook maps to, or null when it is never reported. */
    classifyHookState(test: CucumberHook | undefined): State | null {
        const hookType = this.classifyHookType(test)
        return hookType ? HOOK_STATES[hookType] : null
    }

    /**
     * Whether a failed BEFORE_ALL should run the skip cascade. False when the finish that just
     * arrived had no recorded start — see `lastHookFinishOrphaned`.
     */
    shouldCascadeSkippedScenarios(): boolean {
        return !this.lastHookFinishOrphaned
    }

    /** `<HOOK_TYPE> for <scenario|feature name>`; the separator is a literal ' for '. */
    private hookName(hookType: CucumberHookType): string {
        switch (hookType) {
        case 'BEFORE_EACH':
        case 'AFTER_EACH':
            return `${hookType} for ${this.cucumberData.scenario?.name}`
        case 'BEFORE_ALL':
        case 'AFTER_ALL':
            return `${hookType} for ${this.cucumberData.feature?.name}`
        }
    }

    /**
     * The ABSOLUTE feature path. `beforeFeature`'s uri is already absolute; path.resolve only
     * normalises it. The binary re-bases this itself — `path.relative(session.pathProject, …)`
     * for file_name/location and against the git root for vc_filepath — so sending a
     * pre-relativised value makes both fields depend on the binary's own cwd (SDK-7233).
     */
    private featurePath(): string | undefined {
        const uri = this.cucumberData.uri
        return uri ? path.resolve(process.cwd(), uri) : undefined
    }

    /**
     * The feature path as the bdd meta blob wants it — cwd-relative, matching legacy.
     *
     * Not `featurePath()`: the binary re-bases `test_file_path`/`location` itself but never touches
     * this blob, so an absolute value reaches the dashboard verbatim, home directory and all.
     * Legacy reads the world's `gherkinDocument.uri`, which is already cwd-relative.
     */
    private featureUriForMeta(): string | undefined {
        const absolute = this.featurePath()
        return absolute ? path.relative(process.cwd(), absolute) : undefined
    }

    private featureFilePathEntries() {
        const featurePath = this.featurePath()
        return {
            [TestFrameworkConstants.KEY_TEST_FILE_PATH]: featurePath,
            [TestFrameworkConstants.KEY_TEST_LOCATION]: featurePath,
        }
    }

    async trackEvent(testFrameworkState: State, hookState: State, args: Record<string, unknown> = {}) {
        logger.debug(`WdioCucumberTestFramework.trackEvent: testFrameworkState=${testFrameworkState} hookState=${hookState}`)
        await super.trackEvent(testFrameworkState, hookState, args)

        const instance = this.resolveInstance(testFrameworkState, hookState)
        if (!instance) {
            // Console output before the first scenario has nothing to attach to; legacy drops it
            // just as silently (appendTestItemLog needs a test or hook uuid and has neither).
            const detail = `trackEvent: no instance for testFrameworkState=${testFrameworkState} hookState=${hookState}`
            if (testFrameworkState === TestFrameworkState.LOG) {
                logger.debug(detail)
            } else {
                logger.error(detail)
            }
            return
        }

        const shortState = testFrameworkState.toString().split('.')[1]
        const isHook = CLIUtils.matchHookRegex(shortState)

        try {
            if (isHook && hookState === HookState.PRE) {
                instance.updateMultipleEntries({
                    [TestFrameworkConstants.KEY_HOOK_ID]: uuidv4(),
                })
            }

            if (testFrameworkState === TestFrameworkState.TEST) {
                if (hookState === HookState.PRE) {
                    this.loadScenarioData(instance, args.world as ITestCaseHookParameter)
                    instance.updateMultipleEntries({
                        [TestFrameworkConstants.KEY_TEST_STARTED_AT]: new Date().toISOString(),
                    })
                } else if (hookState === HookState.POST) {
                    instance.updateMultipleEntries({
                        [TestFrameworkConstants.KEY_TEST_ENDED_AT]: new Date().toISOString(),
                    })
                    this.loadScenarioResult(instance, args)
                }
            } else if (testFrameworkState === TestFrameworkState.LOG) {
                this.loadLogEntry(instance, args.logEntry as Record<string, unknown>)
            }

            if (isHook && !this.trackHookEvents(instance, shortState, hookState, args)) {
                // Orphaned hook finish: legacy emits nothing for it at all.
                return
            }
        } catch (error) {
            logger.error(`trackEvent: Error in tracking events: ${error} hookState=${hookState} testFrameworkState=${testFrameworkState}`)
        }

        args.instance = instance
        await this.runHooks(instance, testFrameworkState, hookState, args)
    }

    /**
     * One instance per scenario. `TestFramework.instances` is keyed on
     * `sha256(CLIUtils.getCurrentInstanceName())` = `sha256('<pid>:<threadId>')`, and every
     * `cli/modules/*` reads it through the single `TestFramework.getTrackedInstance()` lookup, so
     * that key is the only one to register under.
     *
     * WDIO forks a worker process per spec and registers its own `beforeScenario`/`afterScenario`
     * as cucumber Before/After hooks that cucumber awaits sequentially, so the previous scenario
     * has always finished before the next one mints its instance — the slot cannot be clobbered
     * mid-scenario the way mocha's two instance-creation triggers can.
     */
    private resolveInstance(testFrameworkState: State, hookState: State): TestFrameworkInstance | null {
        let instance = TestFramework.getTrackedInstance()
        const isHook = CLIUtils.matchHookRegex(testFrameworkState.toString().split('.')[1])

        if (testFrameworkState === TestFrameworkState.TEST && hookState === HookState.PRE) {
            this.trackWdioCucumberInstance(testFrameworkState)
        } else if (isHook && hookState === HookState.PRE && !instance) {
            // BEFORE_ALL runs before any scenario exists. Every other hook reuses the live
            // instance: WDIO's beforeScenario is registered before the user's Before hooks and
            // its afterScenario runs after their After hooks, so an EACH hook always lands on
            // its own scenario's instance and an ALL hook on the last scenario's — which is the
            // uuid legacy stamps as test_run_id.
            this.trackWdioCucumberInstance(testFrameworkState)
        }

        instance = TestFramework.getTrackedInstance()
        if (!instance) {
            logger.debug(`resolveInstance: no instance for testFrameworkState=${testFrameworkState} hookState=${hookState}`)
            return null
        }
        this.updateInstanceState(instance, testFrameworkState, hookState)
        return instance
    }

    private trackWdioCucumberInstance(testFrameworkState: State) {
        const target = CLIUtils.getCurrentInstanceName()
        const trackedContext = TrackedInstance.createContext(target)

        const instance = new TestFrameworkInstance(
            trackedContext,
            this.getTestFrameworks(),
            this.getTestFrameworksVersions(),
            testFrameworkState,
            HookState.NONE
        )

        const frameworkName = this.getTestFrameworks()[0]
        const testUuid = uuidv4()

        instance.updateMultipleEntries({
            [TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME]: frameworkName,
            [TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION]: this.getTestFrameworksVersions()[frameworkName],
            [TestFrameworkConstants.KEY_TEST_LOGS]: [],
            [TestFrameworkConstants.KEY_HOOKS_FINISHED]: new Map(),
            [TestFrameworkConstants.KEY_HOOKS_STARTED]: new Map(),
            [TestFrameworkConstants.KEY_TEST_UUID]: testUuid,
            [TestFrameworkConstants.KEY_TEST_RESULT]: TestFrameworkConstants.DEFAULT_TEST_RESULT,
        })

        // Read by the Web-A11y and App-A11y scan paths to stamp the scan with this test run.
        process.env[TEST_ANALYTICS_ID] = testUuid

        TestFramework.setTrackedInstance(trackedContext, instance)
        logger.debug(`trackWdioCucumberInstance: contextId=${trackedContext.getId()} target=${target} testUuid=${testUuid}`)
    }

    /** Scenario identity. The asymmetries between the fields are deliberate. */
    private loadScenarioData(instance: TestFrameworkInstance, world: ITestCaseHookParameter) {
        if (!world?.pickle) {
            logger.error('loadScenarioData: no pickle on the world object; scenario identity will be empty')
            return
        }
        const pickle = world.pickle
        const feature = world.gherkinDocument?.feature
        this.cucumberData.scenario = pickle
        this.cucumberData.scenariosStarted = true
        this.cucumberData.stepsStarted = false
        // stepDepth is NOT reset here — see the cucumberData doc comment (PB-V8-1).
        this.scenarioSteps = []

        const examples = getScenarioExamples(world)
        // One space before '(' and ', ' between cells, no trailing space.
        const qualifiedName = examples
            ? pickle.name + ' (' + examples.join(', ') + ')'
            : pickle.name

        instance.updateMultipleEntries({
            // The RAW pickle name, deliberately without the examples qualifier that name/scope
            // carry: the binary maps this to `identifier`, and collapsing the two would fold
            // every row of a Scenario Outline into one dashboard test.
            [TestFrameworkConstants.KEY_TEST_ID]: pickle.name,
            [TestFrameworkConstants.KEY_TEST_NAME]: qualifiedName,
            [TestFrameworkConstants.KEY_TEST_SCOPE]: qualifiedName,
            [TestFrameworkConstants.KEY_TEST_SCOPES]: [feature?.name || ''],
            // Step source is never reported for cucumber, unlike the mocha path's test.body.
            [TestFrameworkConstants.KEY_TEST_CODE]: null,
            // Gherkin tag text INCLUDING the leading '@', source order, no dedupe, no casing
            // change. `.map` allocates a new array; the pickle's own collection is never mutated.
            [TestFrameworkConstants.KEY_TEST_TAGS]: pickle.tags.map(({ name }: { name: string }) => name),
            ...this.featureFilePathEntries(),
            [KEY_BDD_META_INFO]: this.buildBddMetaInfo(pickle, feature, examples),
        })
    }

    private buildBddMetaInfo(pickle: Pickle, feature: Feature | undefined, examples: string[] | undefined) {
        return {
            feature: {
                name: feature?.name,
                path: this.featureUriForMeta(),
                description: feature?.description,
            },
            scenario: { name: pickle.name },
            steps: this.scenarioSteps.map(step => ({ ...step })),
            examples: examples ?? [],
        }
    }

    /**
     * Scenario result.
     *
     * KEY_TEST_RESULT_AT is set even though `testHubModule.onAllTestEvents()` cannot actually
     * defer a completion on this line — its `sendTestFrameworkEvent()` call sits outside the
     * else-if chain and runs regardless. Setting it keeps `test_deferred` off the wire and the
     * "dropping due to lack of results" line out of the log.
     */
    private loadScenarioResult(instance: TestFrameworkInstance, args: Record<string, unknown>) {
        const world = args.world as ITestCaseHookParameter | undefined
        const pickle = world?.pickle ?? this.cucumberData.scenario
        const feature = world?.gherkinDocument?.feature ?? this.cucumberData.feature

        const updates: Record<string, unknown> = {
            [TestFrameworkConstants.KEY_TEST_RESULT_AT]: new Date().toISOString(),
        }

        if (pickle) {
            updates[KEY_BDD_META_INFO] = this.buildBddMetaInfo(pickle, feature, getScenarioExamples(world as ITestCaseHookParameter))
        }

        const result = world?.result
        if (result) {
            let testResult = result.status.toLowerCase()
            if (testResult !== 'passed' && testResult !== 'failed') {
                // UNKNOWN / UNDEFINED / AMBIGUOUS / PENDING / SKIPPED all collapse to skipped.
                testResult = 'skipped'
            }

            // A scenario that failed only in a hook reports passed to Observability when the user
            // declared ignoreHooksStatus. `hasStepFailures` is read from the same step store
            // service.afterScenario() consults, so the o11y result and the session status cannot
            // disagree; absent that store, legacy treats the failure as a step failure.
            const hasStepFailures = args.hasStepFailures === undefined ? true : args.hasStepFailures === true
            if (args.ignoreHooksStatus === true && testResult === 'failed' && !hasStepFailures) {
                testResult = 'passed'
            }

            updates[TestFrameworkConstants.KEY_TEST_RESULT] = testResult
            // Cucumber's own protobuf Duration, never an ended_at - started_at delta.
            updates[KEY_TEST_DURATION] = result.duration
                ? result.duration.seconds * 1000 + result.duration.nanos / 1000000
                : undefined

            if (testResult === 'failed') {
                const message = result.message
                // A ONE-element backtrace; the mocha path sends message + stack.
                updates[TestFrameworkConstants.KEY_TEST_FAILURE] = [
                    { backtrace: [message ? removeAnsiColors(message) : 'unknown'] }
                ]
                updates[TestFrameworkConstants.KEY_TEST_FAILURE_REASON] = message ? removeAnsiColors(message) : message
                if (message) {
                    updates[TestFrameworkConstants.KEY_TEST_FAILURE_TYPE] = message.match(/AssertionError/)
                        ? 'AssertionError'
                        : 'UnhandledError'
                }
            }
        }

        instance.updateMultipleEntries(updates)
        this.cucumberData.scenario = undefined
    }

    /**
     * One detached instance per scenario the feature never reached, for the BEFORE_ALL cascade
     * (Rule-nested scenarios included).
     *
     * Detached is load-bearing: these are not registered via `setTrackedInstance`, so neither the
     * live instance nor `process.env[TEST_ANALYTICS_ID]` is disturbed, and the caller sends them
     * straight to TestHub. Routing them through the observers would rename the Automate session,
     * stop the accessibility scan and run a Percy teardown per row, none of which legacy does.
     */
    buildSkippedScenarioInstances(): TestFrameworkInstance[] {
        const feature = this.cucumberData.feature
        if (!feature) {
            logger.debug('buildSkippedScenarioInstances: no feature recorded; nothing to cascade')
            return []
        }

        const scenarios: Scenario[] = []
        for (const child of (feature.children || []) as FeatureChild[]) {
            if (child.rule) {
                for (const ruleChild of (child.rule.children || [])) {
                    if (ruleChild.scenario) {
                        scenarios.push(ruleChild.scenario)
                    }
                }
            } else if (child.scenario) {
                scenarios.push(child.scenario)
            }
        }

        return scenarios.map(scenario => this.buildSkippedScenarioInstance(scenario, feature))
    }

    private buildSkippedScenarioInstance(scenario: Scenario, feature: Feature): TestFrameworkInstance {
        const now = new Date().toISOString()
        const instance = new TestFrameworkInstance(
            TrackedInstance.createContext(CLIUtils.getCurrentInstanceName()),
            this.getTestFrameworks(),
            this.getTestFrameworksVersions(),
            TestFrameworkState.TEST,
            HookState.POST
        )

        const frameworkName = this.getTestFrameworks()[0]
        instance.updateMultipleEntries({
            [TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME]: frameworkName,
            [TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION]: this.getTestFrameworksVersions()[frameworkName],
            [TestFrameworkConstants.KEY_TEST_LOGS]: [],
            [TestFrameworkConstants.KEY_HOOKS_STARTED]: new Map(),
            [TestFrameworkConstants.KEY_HOOKS_FINISHED]: new Map(),
            [TestFrameworkConstants.KEY_TEST_UUID]: uuidv4(),
            // The feature never ran, so no Examples row was selected and there is nothing to
            // qualify: the raw scenario name is name, scope and identifier alike. No tags either
            // — legacy's cascade payload has no world to read them from.
            [TestFrameworkConstants.KEY_TEST_ID]: scenario.name,
            [TestFrameworkConstants.KEY_TEST_NAME]: scenario.name,
            [TestFrameworkConstants.KEY_TEST_SCOPE]: scenario.name,
            [TestFrameworkConstants.KEY_TEST_SCOPES]: [feature.name || ''],
            [TestFrameworkConstants.KEY_TEST_CODE]: null,
            [TestFrameworkConstants.KEY_TEST_RESULT]: 'skipped',
            [TestFrameworkConstants.KEY_TEST_STARTED_AT]: now,
            [TestFrameworkConstants.KEY_TEST_ENDED_AT]: now,
            [TestFrameworkConstants.KEY_TEST_RESULT_AT]: now,
            ...this.featureFilePathEntries(),
            [KEY_TEST_SKIPPED_CASCADE]: true,
            [KEY_BDD_META_INFO]: {
                feature: { name: feature.name, path: this.featurePath(), description: feature.description },
                scenario: { name: scenario.name },
                steps: (scenario.steps || []).map((step: Step) => ({
                    id: step.id,
                    text: step.text,
                    keyword: step.keyword,
                    result: 'skipped',
                })),
                examples: [],
            },
        })

        return instance
    }

    /**
     * Whether the scenario in flight failed in a STEP rather than only in a hook. Kept for
     * callers that have no access to the legacy step store.
     */
    hasStepFailures(): boolean {
        return this.scenarioSteps.some(step => step.result === 'FAILED')
    }

    /**
     * Route a console log to the row it belongs on: the open hook's uuid while a hook is in
     * flight and unfinished, otherwise the scenario's.
     *
     * The record always goes into KEY_TEST_LOGS, because the send path
     * (`testHubModule.onAllTestEvents`) collects the test logs plus the last FINISHED hook's — a
     * record parked on a still-open hook's own array would never be picked up. Routing rides on
     * KEY_HOOK_ID, which `sendLogCreatedEvent` reads in preference to the test uuid.
     *
     * Not delegated to `WdioMochaTestFramework.loadLogEntries()`: its hook check is
     * `matchHookRegex(instance.getCurrentTestState().toString())`, which tests the fully-qualified
     * `TestFrameworkState.BEFORE_ALL` against an anchored `^(BEFORE_|AFTER_)` and never matches.
     */
    private loadLogEntry(instance: TestFrameworkInstance, logEntry: Record<string, unknown>) {
        if (!logEntry) {
            return
        }
        const { level, message, timestamp, kind } = logEntry
        const logRecord: Record<string, unknown> = {
            // SDK-6277 forwards a saveScreenshot() result through this same state with
            // kind: 'TEST_SCREENSHOT'; hardcoding KIND_LOG would reclassify it as a log line.
            kind: (kind as string) ?? TestFrameworkConstants.KIND_LOG,
            message: Buffer.from(message as string),
            level,
            timestamp,
        }

        if (this.openHook) {
            logRecord[TestFrameworkConstants.KEY_HOOK_ID] = this.openHook.hookId
            // The uuid alone is not enough: the binary reads the log's own testFrameworkState to
            // decide hook_run_uuid vs test_run_uuid, and at flush time that is 'LOG'. Carrying
            // the hook's state on the record is what makes the pairing survive (row 24).
            logRecord[TestFrameworkConstants.KEY_HOOK_STATE] = this.openHook.key
        }

        const entries = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_LOGS) as unknown[]
        entries.push(logRecord)
        instance.updateMultipleEntries({
            [TestFrameworkConstants.KEY_TEST_LOGS]: entries,
        })
    }

    /**
     * Hook lifecycle. Entries are keyed by the short state name, matching how the binary looks
     * them up via `event.test_hooks_started[request.testFrameworkState]`.
     *
     * @returns false when a finish arrived with no recorded start, so the caller emits nothing.
     */
    private trackHookEvents(instance: TestFrameworkInstance, key: string, hookState: State, args: Record<string, unknown>): boolean {
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
            const hookId = (TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOK_ID) || '') as string
            const hook: Record<string, unknown> = {
                key,
                [TestFrameworkConstants.KEY_HOOK_ID]: hookId,
                [TestFrameworkConstants.KEY_HOOK_RESULT]: TestFrameworkConstants.DEFAULT_HOOK_RESULT,
                [TestFrameworkConstants.KEY_EVENT_STARTED_AT]: new Date().toISOString(),
                [TestFrameworkConstants.KEY_HOOK_LOGS]: [],
                [TestFrameworkConstants.KEY_HOOK_NAME]: this.hookName(key as CucumberHookType),
                // A hook's scope is the FEATURE name for all four types. `event.test_scope` is the
                // examples-qualified scenario name, and an ALL hook has no scenario data at all,
                // so the binary reads this key off the hook record first.
                [KEY_HOOK_SCOPE]: this.cucumberData.feature?.name,
                ...this.featureFilePathEntries(),
            }
            hooksStarted.get(key)?.push(hook)
            updates[WdioCucumberTestFramework.KEY_HOOK_LAST_STARTED] = key
            this.openHook = { key, hookId }
            this.lastHookFinishOrphaned = false
            instance.updateMultipleEntries(updates)
            logger.debug(`trackHookEvents: hook started hookState=${key} name=${hook[TestFrameworkConstants.KEY_HOOK_NAME]}`)
            return true
        }

        const hooksList = hooksStarted.get(key) || []
        if (hooksList.length === 0) {
            logger.warn(`trackHookEvents: hook finish for hookState=${key} has no recorded start — dropping the finish and any cascade`)
            this.openHook = null
            this.lastHookFinishOrphaned = true
            instance.updateMultipleEntries(updates)
            return false
        }

        const hook = hooksList.pop() as Record<string, unknown>
        const hookResult = args.result as Frameworks.TestResult | undefined
        if (hookResult) {
            // passed / failed only — the hook path has no 'skipped' arm, unlike the scenario path.
            // Leaving hook_result at 'pending' makes the binary coerce a finished hook to
            // 'passed', so a failing before-hook would show green while the runner exits 1.
            hook[TestFrameworkConstants.KEY_HOOK_RESULT] = hookResult.passed ? 'passed' : 'failed'
            // WDIO reports hook duration as plain ms on the result, not as cucumber's Duration.
            hook[KEY_HOOK_RETRIES] = hookResult.retries
            hook[KEY_HOOK_DURATION] = hookResult.duration
        } else {
            logger.warn(`trackHookEvents: no result on the hook finish for '${key}'; result stays pending`)
        }
        hook[TestFrameworkConstants.KEY_EVENT_ENDED_AT] = new Date().toISOString()
        hooksFinished.get(key)?.push(hook)
        updates[WdioCucumberTestFramework.KEY_HOOK_LAST_FINISHED] = key
        this.openHook = null
        this.lastHookFinishOrphaned = false
        instance.updateMultipleEntries(updates)
        logger.debug(`trackHookEvents: hook finished hookState=${key} result=${hook[TestFrameworkConstants.KEY_HOOK_RESULT]}`)
        return true
    }
}
