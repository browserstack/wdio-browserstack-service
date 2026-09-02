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
import type { CucumberHook, Feature, ITestCaseHookParameter, Pickle } from '../../cucumber-types.js'

/**
 * `test_duration` and `bdd_meta_info` are read by the binary's WebdriverIO-cucumber module but
 * have no entry in TestFrameworkConstants, which is shared with the mocha path. Kept local rather
 * than appended there so this framework owns its own wire keys.
 */
const KEY_TEST_DURATION = 'test_duration'
const KEY_BDD_META_INFO = 'bdd_meta_info'

/**
 * Per-hook wire keys. The binary cannot derive any of the three from the event: a hook's scope is
 * the FEATURE name (parity row 16) while the event carries the examples-qualified SCENARIO name,
 * and BEFORE_ALL/AFTER_ALL fire on an instance that has no scenario data at all. Retries and
 * duration (row 26) come from WDIO's hook result, which only this side sees.
 */
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
 * File-path pair sent with every scenario/hook event.
 *
 * The ABSOLUTE feature path is deliberate: the binary re-bases it itself
 * (`path.relative(session.pathProject, …)` for `file_name`/`location` and against the git root for
 * `vc_filepath`). Legacy reported both pre-relativised — sending that shape here made both fields
 * come out wrong, and sending `undefined` threw inside the binary and dropped the event (SDK-7233).
 */
const resolveFeatureFilePaths = (featurePath: string | undefined) => ({
    [TestFrameworkConstants.KEY_TEST_FILE_PATH]: featurePath,
    [TestFrameworkConstants.KEY_TEST_LOCATION]: featurePath
        ? path.relative(process.cwd(), featurePath)
        : undefined,
})

/**
 * CLI test framework for `framework: 'cucumber'` under WebdriverIO.
 *
 * Extends the BASE TestFramework, never WdioMochaTestFramework: WDIO does not call
 * `beforeTest`/`afterTest`/titled hooks for cucumber at all, so mocha's INIT_TEST/TEST/hook
 * boundary semantics have no source here and borrowing them would report cucumber through the
 * wrong runner's event model.
 *
 * Cucumber's unit of work is the scenario, and every `cli/modules/*` observer subscribes to
 * `TestFrameworkState.TEST` — so a scenario raises TEST/PRE at `beforeScenario` and TEST/POST at
 * `afterScenario`, and the module set works unchanged.
 */
export default class WdioCucumberTestFramework extends TestFramework {
    static KEY_HOOK_LAST_STARTED = 'test_hook_last_started'
    static KEY_HOOK_LAST_FINISHED = 'test_hook_last_finished'

    /**
     * The bookkeeping `classifyHookType()` derives hook types from. A cucumber hook invocation
     * carries no title, and `BeforeAll`/`AfterAll` pass no hook object at all, so classification
     * is state-machine derived — `util.ts → getHookType()` is Mocha-title-shaped and can only
     * return 'unknown' or throw here.
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
     * Steps accumulated for the scenario in flight. Re-allocated (never cleared in place) at each
     * scenario start so a payload already built from the previous scenario can never observe the
     * next one's steps.
     */
    private scenarioSteps: StepMeta[] = []

    /** The hook currently open on this worker — started and not yet finished. */
    private openHook: { key: string, hookId: string } | null = null

    constructor(testFrameworks: string[], testFrameworkVersions: Record<string, string>, binSessionId: string) {
        super(testFrameworks, testFrameworkVersions, binSessionId)
        logger.debug('WdioCucumberTestFramework: constructed')
    }

    /**
     * Feature bookkeeping. Raises no framework state — cucumber has no feature-level wire event,
     * and `beforeSuite`/`afterSuite` are not part of its WDIO surface.
     */
    onFeatureStart(uri: string, feature: Feature) {
        logger.debug(`onFeatureStart: uri=${uri} feature=${feature?.name}`)
        this.cucumberData.scenariosStarted = false
        this.cucumberData.feature = feature
        this.cucumberData.uri = uri
    }

    /**
     * Step bookkeeping. Steps travel inside the scenario payload's BDD meta, never as their own
     * event — `TestFrameworkState.STEP` has zero producers anywhere in this SDK.
     */
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
     * Classify a cucumber hook invocation from the bookkeeping state.
     *
     * Returns null for a step-scoped hook (`BeforeStep`/`AfterStep`), which is never reported —
     * reporting it would change the dashboard hook count, which is a feature and not parity.
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

    /** The TestFrameworkState a cucumber hook invocation maps to, or null when unreported. */
    classifyHookState(test: CucumberHook | undefined): State | null {
        const hookType = this.classifyHookType(test)
        return hookType ? HOOK_STATES[hookType] : null
    }

    /**
     * `<HOOK_TYPE> for <scenario|feature name>` — the separator is a literal ' ' + 'for' + ' '.
     */
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

    private featurePath(): string | undefined {
        const uri = this.cucumberData.uri
        return uri ? path.resolve(process.cwd(), uri) : undefined
    }

    async trackEvent(testFrameworkState: State, hookState: State, args: Record<string, unknown> = {}) {
        logger.debug(`WdioCucumberTestFramework.trackEvent: testFrameworkState=${testFrameworkState} hookState=${hookState}`)
        await super.trackEvent(testFrameworkState, hookState, args)

        const instance = this.resolveInstance(testFrameworkState, hookState)
        if (!instance) {
            // Console output emitted before the first scenario (or before BeforeAll) has nothing
            // to attach to. The legacy path drops it just as silently, so this is expected rather
            // than a failure.
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

            if (isHook) {
                this.trackHookEvents(instance, shortState, hookState, args)
            }
        } catch (error) {
            logger.error(`trackEvent: Error in tracking events: ${error} hookState=${hookState} testFrameworkState=${testFrameworkState}`)
        }

        args.instance = instance
        await this.runHooks(instance, testFrameworkState, hookState, args)
    }

    /**
     * One instance per scenario, keyed by the worker (`pid:threadId`) — the single lookup every
     * `cli/modules/*` reads, via `TestFramework.getTrackedInstance()`. WDIO forks one worker
     * process per spec file, so the worker key is the scenario's execution context; a thread id
     * alone would collide once threads are reused.
     */
    private resolveInstance(testFrameworkState: State, hookState: State): TestFrameworkInstance | null {
        let instance = TestFramework.getTrackedInstance()
        const isHook = CLIUtils.matchHookRegex(testFrameworkState.toString().split('.')[1])

        if (testFrameworkState === TestFrameworkState.TEST && hookState === HookState.PRE) {
            // Every scenario is its own test. BEFORE_EACH hooks fire after beforeScenario, so
            // they land on the instance minted here and never on the previous scenario's.
            this.trackWdioCucumberInstance(testFrameworkState)
        } else if (isHook && hookState === HookState.PRE && !instance) {
            // BEFORE_ALL runs before any scenario exists, so it has no instance to attach to.
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

        // Read by the A11y and App-A11y scan paths.
        process.env[TEST_ANALYTICS_ID] = testUuid

        TestFramework.setTrackedInstance(trackedContext, instance)
        logger.debug(`trackWdioCucumberInstance: contextId=${trackedContext.getId()} target=${target} testUuid=${testUuid}`)
    }

    /**
     * Scenario identity. Every field below is fixed by a parity row and the asymmetries are
     * deliberate — see `wdioCucumberTestFramework` notes in the SDK-7414 parity table.
     */
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
        this.cucumberData.stepDepth = 0
        // Fresh array, never a clear-in-place: the previous scenario's payload must not be able to
        // observe this scenario's steps through a retained reference.
        this.scenarioSteps = []

        const examples = getScenarioExamples(world)
        // Exactly one space before '(' and ', ' between cells — asserted character-for-character.
        const qualifiedName = examples
            ? pickle.name + ' (' + examples.join(', ') + ')'
            : pickle.name
        const featurePath = this.featurePath()

        instance.updateMultipleEntries({
            // The RAW pickle name, deliberately WITHOUT the examples qualifier that `name`/`scope`
            // carry. The binary maps this to `identifier`; collapsing the two would change how the
            // dashboard groups Scenario Outline rows.
            [TestFrameworkConstants.KEY_TEST_ID]: pickle.name,
            [TestFrameworkConstants.KEY_TEST_NAME]: qualifiedName,
            [TestFrameworkConstants.KEY_TEST_SCOPE]: qualifiedName,
            [TestFrameworkConstants.KEY_TEST_SCOPES]: [feature?.name || ''],
            // Step source is never reported for cucumber.
            [TestFrameworkConstants.KEY_TEST_CODE]: null,
            // Gherkin tag text INCLUDING the leading '@', source order, no dedupe, no lowercasing.
            // `.map` allocates a new array — the pickle's own tag collection is never mutated.
            [TestFrameworkConstants.KEY_TEST_TAGS]: pickle.tags.map(({ name }: { name: string }) => name),
            ...resolveFeatureFilePaths(featurePath),
            [KEY_BDD_META_INFO]: this.buildBddMetaInfo(pickle, feature, featurePath, examples),
        })
    }

    private buildBddMetaInfo(pickle: Pickle, feature: Feature | undefined, featurePath: string | undefined, examples: string[] | undefined) {
        return {
            feature: {
                name: feature?.name,
                path: featurePath,
                description: feature?.description,
            },
            scenario: { name: pickle.name },
            steps: this.scenarioSteps.map(step => ({ ...step })),
            examples: examples ?? [],
        }
    }

    /**
     * Scenario result, loaded at the real "scenario ends" state.
     *
     * KEY_TEST_RESULT_AT is load-bearing, not decoration: `testHubModule → onAllTestEvents()`
     * treats a TEST/POST without it as result-less, marks the test deferred, and then waits for a
     * `LOG_REPORT` POST to recover it — a state cucumber never emits.
     */
    private loadScenarioResult(instance: TestFrameworkInstance, args: Record<string, unknown>) {
        const world = args.world as ITestCaseHookParameter | undefined
        const pickle = world?.pickle ?? this.cucumberData.scenario
        const feature = world?.gherkinDocument?.feature ?? this.cucumberData.feature

        const updates: Record<string, unknown> = {
            [TestFrameworkConstants.KEY_TEST_RESULT_AT]: new Date().toISOString(),
        }

        if (pickle) {
            updates[KEY_BDD_META_INFO] = this.buildBddMetaInfo(pickle, feature, this.featurePath(), getScenarioExamples(world as ITestCaseHookParameter))
        }

        const result = world?.result
        if (result) {
            let testResult = result.status.toLowerCase()
            if (testResult !== 'passed' && testResult !== 'failed') {
                // UNKNOWN / UNDEFINED / AMBIGUOUS / PENDING / SKIPPED all collapse to skipped.
                testResult = 'skipped'
            }

            // A scenario that failed only because of a hook is reported as passed when the user
            // has declared ignoreHooksStatus. The same flag independently gates the session-status
            // accumulation in service.ts — two sites, one flag.
            if (args.ignoreHooksStatus === true && testResult === 'failed' && !this.hasStepFailures()) {
                testResult = 'passed'
            }

            updates[TestFrameworkConstants.KEY_TEST_RESULT] = testResult
            // Cucumber's own protobuf Duration, NOT an ended_at - started_at delta.
            updates[KEY_TEST_DURATION] = result.duration
                ? result.duration.seconds * 1000 + result.duration.nanos / 1000000
                : undefined

            if (testResult === 'failed') {
                const message = result.message
                // A ONE-element backtrace. The mocha path sends two entries (message + stack);
                // cucumber's result carries a single combined message.
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

    private hasStepFailures(): boolean {
        return this.scenarioSteps.some(step => step.result === 'FAILED')
    }

    /**
     * Route a console log to the row it belongs on: the open hook's uuid while a hook is in
     * flight and unfinished, otherwise the scenario's uuid.
     *
     * The record itself always goes into KEY_TEST_LOGS, because the send path
     * (`testHubModule → onAllTestEvents`, unchanged) collects test logs plus the last FINISHED
     * hook's logs — a record parked on a still-open hook's own array would never be picked up.
     * The routing is carried by KEY_HOOK_ID on the record, which `sendLogCreatedEvent` reads in
     * preference to the test uuid.
     */
    private loadLogEntry(instance: TestFrameworkInstance, logEntry: Record<string, unknown>) {
        if (!logEntry) {
            return
        }
        const { level, message, timestamp } = logEntry
        const logRecord: Record<string, unknown> = {
            kind: TestFrameworkConstants.KIND_LOG,
            message: Buffer.from(message as string),
            level,
            timestamp,
        }

        if (this.openHook) {
            logRecord[TestFrameworkConstants.KEY_HOOK_ID] = this.openHook.hookId
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
     * A finish with no recorded start is dropped rather than emitted — an unmatched
     * HookRunFinished orphans a hook row the backend cannot pair.
     */
    private trackHookEvents(instance: TestFrameworkInstance, key: string, hookState: State, args: Record<string, unknown>) {
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
        const featurePath = this.featurePath()

        if (hookState === HookState.PRE) {
            const hookId = (TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOK_ID) || '') as string
            const hook: Record<string, unknown> = {
                key,
                [TestFrameworkConstants.KEY_HOOK_ID]: hookId,
                [TestFrameworkConstants.KEY_HOOK_RESULT]: TestFrameworkConstants.DEFAULT_HOOK_RESULT,
                [TestFrameworkConstants.KEY_EVENT_STARTED_AT]: new Date().toISOString(),
                [TestFrameworkConstants.KEY_HOOK_LOGS]: [],
                [TestFrameworkConstants.KEY_HOOK_NAME]: this.hookName(key as CucumberHookType),
                [KEY_HOOK_SCOPE]: this.cucumberData.feature?.name,
                ...resolveFeatureFilePaths(featurePath),
            }
            hooksStarted.get(key)?.push(hook)
            updates[WdioCucumberTestFramework.KEY_HOOK_LAST_STARTED] = key
            this.openHook = { key, hookId }
            logger.debug(`trackHookEvents: hook started key=${key} name=${hook[TestFrameworkConstants.KEY_HOOK_NAME]}`)
        } else if (hookState === HookState.POST) {
            const hooksList = hooksStarted.get(key) || []
            if (hooksList.length === 0) {
                logger.warn(`trackHookEvents: dropping hook finish for '${key}' — no matching start was recorded`)
                this.openHook = null
                return
            }

            const hook = hooksList.pop() as Record<string, unknown>
            const hookResult = args.result as Frameworks.TestResult | undefined
            // passed / failed only — no 'skipped' arm, unlike the scenario result path.
            if (hookResult) {
                hook[TestFrameworkConstants.KEY_HOOK_RESULT] = hookResult.passed ? 'passed' : 'failed'
                // WDIO reports hook duration in plain ms on the result, not as cucumber's protobuf
                // Duration — legacy sends it through unchanged and so does this.
                hook[KEY_HOOK_RETRIES] = hookResult.retries
                hook[KEY_HOOK_DURATION] = hookResult.duration
            }
            hook[TestFrameworkConstants.KEY_EVENT_ENDED_AT] = new Date().toISOString()
            hooksFinished.get(key)?.push(hook)
            updates[WdioCucumberTestFramework.KEY_HOOK_LAST_FINISHED] = key
            this.openHook = null
            logger.debug(`trackHookEvents: hook finished key=${key} result=${hook[TestFrameworkConstants.KEY_HOOK_RESULT]}`)
        }

        instance.updateMultipleEntries(updates)
    }
}
