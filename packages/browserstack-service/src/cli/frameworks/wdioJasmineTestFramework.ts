import path from 'node:path'
import util from 'node:util'
import { v4 as uuidv4 } from 'uuid'
import type { Frameworks } from '@wdio/types'
import type { HookStats, TestStats } from '@wdio/reporter'

import TestFramework from './testFramework.js'
import { TestFrameworkState } from '../states/testFrameworkState.js'
import { HookState } from '../states/hookState.js'
import TestFrameworkInstance from '../instances/testFrameworkInstance.js'
import TrackedInstance from '../instances/trackedInstance.js'
import { CLIUtils } from '../cliUtils.js'
import { TestFrameworkConstants } from './constants/testFrameworkConstants.js'
import { BStackLogger as logger } from '../cliLogger.js'
import { getHookType, getTestTags, removeAnsiColors } from '../../util.js'
import { shouldProcessEventForTesthub } from '../../testHub/utils.js'
import { TEST_ANALYTICS_ID } from '../../constants.js'
import type TestHubModule from '../modules/testHubModule.js'

/** What the reporter knows at each event and the framework cannot see: its suite stack and suite file. */
export interface JasmineSuiteContext {
    scopes: string[]
    suiteFile?: string
}

interface FailureFields {
    failure?: Array<{ backtrace: string[] }>
    failureReason?: string
    failureType?: string | null
}

/**
 * CLI test framework for `framework: 'jasmine'` under WebdriverIO.
 *
 * Extends the BASE TestFramework, never WdioMochaTestFramework: jasmine's identity (fullName),
 * hook taxonomy and skip/exclude states differ from mocha's.
 *
 * Two event sources, as on the legacy flow, both through `trackEvent`:
 * - the WDIO reporter (`reporter.ts`, `source: 'reporter'`) feeds Test Observability only — it is the one
 *   jasmine source that sees pending, focused-out and beforeAll-failed specs. Its hooks are not awaited by
 *   WDIO, so its events are applied through one ordered queue and sent straight to TestHubModule, never to
 *   the other modules;
 * - the service's awaited beforeTest/afterTest drive the product modules (a11y, Automate, Percy) through
 *   the observers, for executed specs only, with TestHub skipped.
 */
export default class WdioJasmineTestFramework extends TestFramework {
    // Same data keys WdioMochaTestFramework uses: TestHubModule's LOG arm reads them through
    // WdioMochaTestFramework.getLogEntries/clearLogs.
    static KEY_HOOK_LAST_STARTED = 'test_hook_last_started'
    static KEY_HOOK_LAST_FINISHED = 'test_hook_last_finished'
    static KEY_TEST_RETRIES = 'test_retries'
    static KEY_TEST_DURATION = 'test_duration'
    static KEY_HOOK_IDENTIFIER = 'hook_identifier'
    static KEY_HOOK_SCOPE = 'hook_scope'
    static KEY_HOOK_SCOPES = 'hook_scopes'
    static KEY_HOOK_DURATION = 'hook_duration'
    static KEY_HOOK_FAILURE = 'hook_failure'
    static KEY_HOOK_FAILURE_TYPE = 'hook_failure_type'
    static KEY_HOOK_FAILURE_REASON = 'hook_failure_reason'

    static #hookTypes = new Map([
        ['beforeAll', 'BEFORE_ALL'],
        ['afterAll', 'AFTER_ALL'],
        ['beforeEach', 'BEFORE_EACH'],
        ['afterEach', 'AFTER_EACH'],
    ])

    #specInstances = new Map<string, TestFrameworkInstance>()
    // Open specs by fullName: how the service's hooks find the instance the reporter minted.
    #specsByFullName = new Map<string, TestFrameworkInstance>()
    // Every spec of this worker by uuid: legacy attaches HTTP logs and screenshots to the last started spec, even after it ended.
    #specsByUuid = new Map<string, TestFrameworkInstance>()
    #serviceOnly = new Set<TestFrameworkInstance>()
    #suiteTitles = new Map<TestFrameworkInstance, unknown>()
    #testHub: TestHubModule | null = null
    // beforeAll/afterAll never overlap, so a hook's uid (its title) is unique while it is open.
    #hookInstances = new Map<string, TestFrameworkInstance>()
    #openHook: TestFrameworkInstance | null = null
    #lastSpec: TestFrameworkInstance | null = null
    #queue: Promise<void> = Promise.resolve()
    #pendingEvents = 0

    constructor(testFrameworks: string[], testFrameworkVersions: Record<string, string>, binSessionId: string) {
        super(testFrameworks, testFrameworkVersions, binSessionId)
        logger.debug('WdioJasmineTestFramework: constructed')
    }

    /** True when no reporter event is still waiting to be dispatched (the reporter's `isSynchronised`). */
    isIdle() {
        return this.#pendingEvents === 0
    }

    /** The WDIO `hookName` a jasmine hook runs under, as the hook-type key `getHookType` returns for mocha titles. */
    static hookTypeFromName(hookName: string | undefined) {
        return WdioJasmineTestFramework.#hookTypes.get(hookName ?? '') ?? 'unknown'
    }

    /** The state the reporter reports a hook in: BEFORE_ALL/AFTER_ALL, else NONE (each-hooks are not reported). */
    static reporterHookState(hookTitle: string | undefined): State {
        return WdioJasmineTestFramework.#hookState(getHookType(String(hookTitle ?? '').toLowerCase())) ?? TestFrameworkState.NONE
    }

    setTestHubModule(testHub: TestHubModule | null | undefined) {
        this.#testHub = testHub ?? null
    }

    /**
     * Reporter events (`source: 'reporter'`) are applied before this returns its promise: TEST PRE writes the
     * spec's uuid to `args.testUuid`. The service's hooks call this without a source: INIT_TEST pins the
     * spec's instance and uuid; TEST PRE/POST reach the product modules. LOG_REPORT and the hook states carry
     * nothing jasmine needs: results come from the reporter.
     */
    async trackEvent(testFrameworkState: State, hookState: State, args: Record<string, unknown> = {}) {
        if (args.source === 'reporter') {
            this.#trackReporterEvent(testFrameworkState, hookState, args)
            return
        }
        if (testFrameworkState === TestFrameworkState.LOG) {
            this.#log(args.logEntry as Record<string, unknown>)
            return
        }
        try {
            await this.#queue
            if (testFrameworkState !== TestFrameworkState.INIT_TEST && testFrameworkState !== TestFrameworkState.TEST) {
                return
            }
            const test = (args.test ?? {}) as { fullName?: string, description?: string, file?: string }
            const instance = this.#serviceInstance(test)
            TestFramework.setTrackedInstance(instance.getContext(), instance)
            process.env[TEST_ANALYTICS_ID] = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_UUID)
            if (testFrameworkState === TestFrameworkState.INIT_TEST) {
                return
            }

            const moduleArgs: Record<string, unknown> = { ...args }
            if (hookState === HookState.PRE) {
                this.#suiteTitles.set(instance, args.suiteTitle)
            } else {
                // afterTest hands over the raw `Jasmine__TopLevel__Suite`; the modules need the describe chain beforeTest derived
                moduleArgs.suiteTitle = this.#suiteTitles.get(instance) ?? args.suiteTitle
                this.#suiteTitles.delete(instance)
                if (this.#serviceOnly.delete(instance) && test.fullName && this.#specsByFullName.get(test.fullName) === instance) {
                    this.#specsByFullName.delete(test.fullName)
                }
            }
            await this.#toModules(instance, testFrameworkState, hookState, moduleArgs)
        } catch (error) {
            logger.error(`WdioJasmineTestFramework: service event ${testFrameworkState}/${hookState} failed: ${util.format(error)}`)
        }
    }

    #trackReporterEvent(testFrameworkState: State, hookState: State, args: Record<string, unknown>) {
        const context = args.context as JasmineSuiteContext
        if (testFrameworkState === TestFrameworkState.TEST) {
            if (hookState === HookState.PRE) {
                args.testUuid = this.#testStarted(args.testStats as TestStats, context)
            } else {
                this.#testEnded(args.testStats as TestStats, context)
            }
        } else if (testFrameworkState === TestFrameworkState.LOG) {
            this.#log(args.logEntry as Record<string, unknown> | undefined)
        } else if (hookState === HookState.PRE) {
            this.#hookStarted(testFrameworkState, args.hookStats as HookStats, context)
        } else {
            this.#hookEnded(testFrameworkState, args.hookStats as HookStats)
        }
    }

    #testStarted(testStats: TestStats, context: JasmineSuiteContext) {
        try {
            logger.debug(`WdioJasmineTestFramework: test start uid=${testStats.uid}`)
            const instance = this.#createInstance()
            const scopes = [...context.scopes]
            const fullTitle = testStats.fullTitle
            instance.updateMultipleEntries({
                [TestFrameworkConstants.KEY_TEST_UUID]: uuidv4(),
                [TestFrameworkConstants.KEY_TEST_RESULT]: TestFrameworkConstants.DEFAULT_TEST_RESULT,
                [TestFrameworkConstants.KEY_TEST_ID]: fullTitle,
                [TestFrameworkConstants.KEY_TEST_NAME]: testStats.title,
                [TestFrameworkConstants.KEY_TEST_SCOPE]: fullTitle,
                [TestFrameworkConstants.KEY_TEST_SCOPES]: scopes,
                [TestFrameworkConstants.KEY_TEST_TAGS]: getTestTags(testStats as unknown as Frameworks.Test, scopes),
                ...this.#filePaths(context.suiteFile),
                [TestFrameworkConstants.KEY_TEST_STARTED_AT]: testStats.start?.toISOString(),
                [WdioJasmineTestFramework.KEY_TEST_DURATION]: testStats._duration,
                [WdioJasmineTestFramework.KEY_TEST_RETRIES]: { limit: testStats.retries || 0, attempts: testStats.retries || 0 },
            })
            this.#specInstances.set(testStats.uid, instance)
            this.#specsByFullName.set(fullTitle, instance)
            this.#specsByUuid.set(TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_UUID) as string, instance)
            // Registered synchronously: the service's beforeTest for this spec may read it before the queue runs.
            TestFramework.setTrackedInstance(instance.getContext(), instance)

            const args = { test: this.#specArg(testStats, context), suiteTitle: this.#suiteTitle(testStats) }
            this.#enqueue('TEST/PRE', async () => {
                this.#lastSpec = instance
                await this.#toTestHub(instance, TestFrameworkState.TEST, HookState.PRE, args)
            })
            return TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_UUID) as string
        } catch (error) {
            logger.error(`WdioJasmineTestFramework: test start failed: ${util.format(error)}`)
        }
    }

    #testEnded(testStats: TestStats, context: JasmineSuiteContext) {
        try {
            const instance = this.#specInstances.get(testStats.uid)
            if (!instance) {
                logger.debug(`WdioJasmineTestFramework: no instance for test end uid=${testStats.uid}`)
                return
            }
            this.#specInstances.delete(testStats.uid)
            if (this.#specsByFullName.get(testStats.fullTitle) === instance) {
                this.#specsByFullName.delete(testStats.fullTitle)
            }

            const state = testStats.state
            const error = testStats.error
            let result: string = state
            let failure: FailureFields = {}
            if (state === 'failed') {
                result = (error && error.message && error.message.includes('sync skip; aborting execution')) ? 'ignore' : 'failed'
                if (error) {
                    failure = this.#failureFields(error)
                }
            }
            const entries: Record<string, unknown> = {
                [TestFrameworkConstants.KEY_TEST_RESULT]: result,
                [TestFrameworkConstants.KEY_TEST_STARTED_AT]: testStats.start?.toISOString(),
                [TestFrameworkConstants.KEY_TEST_ENDED_AT]: testStats.end?.toISOString(),
                [WdioJasmineTestFramework.KEY_TEST_DURATION]: testStats._duration,
                [TestFrameworkConstants.KEY_TEST_RESULT_AT]: new Date().toISOString(),
            }
            if (failure.failure) {
                entries[TestFrameworkConstants.KEY_TEST_FAILURE] = failure.failure
                entries[TestFrameworkConstants.KEY_TEST_FAILURE_REASON] = failure.failureReason
                entries[TestFrameworkConstants.KEY_TEST_FAILURE_TYPE] = failure.failureType
            }
            const testResult = {
                passed: state === 'passed',
                skipped: state === 'skipped',
                error,
                duration: testStats._duration,
                retries: { limit: testStats.retries || 0, attempts: testStats.retries || 0 },
            }
            const args = { test: this.#specArg(testStats, context), result: testResult, suiteTitle: this.#suiteTitle(testStats) }
            this.#enqueue('TEST/POST', async () => {
                instance.updateMultipleEntries(entries)
                await this.#toTestHub(instance, TestFrameworkState.TEST, HookState.POST, args)
            })
        } catch (error) {
            logger.error(`WdioJasmineTestFramework: test end failed: ${util.format(error)}`)
        }
    }

    #hookStarted(hookFrameworkState: State, hookStats: HookStats, context: JasmineSuiteContext) {
        try {
            const title = hookStats.title
            const key = getHookType(String(title ?? '').toLowerCase())
            if (!WdioJasmineTestFramework.#hookState(key) || context.scopes.length === 0) {
                logger.debug(`WdioJasmineTestFramework: hook start not reported title=${title} scopes=${context.scopes.length}`)
                return
            }
            const scopes = [...context.scopes]
            const instance = this.#createInstance()
            const hookId = uuidv4()
            const hook: Record<string, unknown> = {
                key,
                [TestFrameworkConstants.KEY_HOOK_ID]: hookId,
                [TestFrameworkConstants.KEY_HOOK_RESULT]: TestFrameworkConstants.DEFAULT_HOOK_RESULT,
                [TestFrameworkConstants.KEY_EVENT_STARTED_AT]: hookStats.start?.toISOString(),
                [TestFrameworkConstants.KEY_HOOK_LOGS]: [],
                [TestFrameworkConstants.KEY_HOOK_NAME]: title,
                [WdioJasmineTestFramework.KEY_HOOK_IDENTIFIER]: `${title} for ${scopes[scopes.length - 1]}`,
                [WdioJasmineTestFramework.KEY_HOOK_SCOPE]: `${scopes[0]} - ${title}`,
                [WdioJasmineTestFramework.KEY_HOOK_SCOPES]: scopes,
                [WdioJasmineTestFramework.KEY_HOOK_DURATION]: hookStats._duration,
                ...this.#filePaths(context.suiteFile),
            }
            instance.updateData(TestFrameworkConstants.KEY_HOOK_ID, hookId)
            // The session event is keyed by KEY_TEST_UUID: it links the hook run to its Automate session and platform
            instance.updateData(TestFrameworkConstants.KEY_TEST_UUID, hookId)
            this.#hookInstances.set(hookStats.uid, instance)

            const emitHook = shouldProcessEventForTesthub('HookRunStarted')
            this.#enqueue(`${key}/PRE`, async () => {
                this.#openHook = instance
                const hooksStarted = TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOKS_STARTED) as Map<string, unknown[]>
                hooksStarted.set(key, [hook])
                instance.updateData(WdioJasmineTestFramework.KEY_HOOK_LAST_STARTED, key)
                if (emitHook) {
                    await this.#toTestHub(instance, hookFrameworkState, HookState.PRE, { hook: hookStats })
                }
            })
        } catch (error) {
            logger.error(`WdioJasmineTestFramework: hook start failed: ${util.format(error)}`)
        }
    }

    #hookEnded(hookFrameworkState: State, hookStats: HookStats) {
        try {
            const instance = this.#hookInstances.get(hookStats.uid)
            if (!instance) {
                return
            }
            this.#hookInstances.delete(hookStats.uid)
            const key = getHookType(String(hookStats.title ?? '').toLowerCase())

            const state = hookStats.state
            const error = hookStats.error
            let result = state as string | undefined
            let failure: FailureFields = {}
            if (state === 'failed') {
                result = (error && error.message && error.message.includes('sync skip; aborting execution')) ? 'ignore' : 'failed'
                if (error) {
                    failure = this.#failureFields(error)
                }
            }
            const endedAt = hookStats.end?.toISOString()
            const duration = hookStats._duration
            const emitHook = shouldProcessEventForTesthub('HookRunFinished')
            this.#enqueue(`${key}/POST`, async () => {
                if (this.#openHook === instance) {
                    this.#openHook = null
                }
                const hooksStarted = TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOKS_STARTED) as Map<string, Record<string, unknown>[]>
                const hooksFinished = TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOKS_FINISHED) as Map<string, Record<string, unknown>[]>
                const hook = hooksStarted.get(key)?.pop()
                if (!hook) {
                    return
                }
                if (result) {
                    hook[TestFrameworkConstants.KEY_HOOK_RESULT] = result
                }
                hook[TestFrameworkConstants.KEY_EVENT_ENDED_AT] = endedAt
                hook[WdioJasmineTestFramework.KEY_HOOK_DURATION] = duration
                if (failure.failure) {
                    hook[WdioJasmineTestFramework.KEY_HOOK_FAILURE] = failure.failure
                    hook[WdioJasmineTestFramework.KEY_HOOK_FAILURE_REASON] = failure.failureReason
                    hook[WdioJasmineTestFramework.KEY_HOOK_FAILURE_TYPE] = failure.failureType
                }
                hooksFinished.set(key, [hook])
                instance.updateData(WdioJasmineTestFramework.KEY_HOOK_LAST_FINISHED, key)
                if (emitHook) {
                    await this.#toTestHub(instance, hookFrameworkState, HookState.POST, { hook: hookStats, result: { passed: result === 'passed', error } })
                }
            })
        } catch (error) {
            logger.error(`WdioJasmineTestFramework: hook end failed: ${util.format(error)}`)
        }
    }

    /**
     * Console logs: an open beforeAll/afterAll wins, else the last-started spec, even after it ended.
     * HTTP command logs and screenshots name their spec (`test_run_uuid`), as legacy did; unknown uuids are dropped.
     */
    #log(logEntry: Record<string, unknown> | undefined) {
        try {
            if (!logEntry || !shouldProcessEventForTesthub('LogCreated')) {
                return
            }
            const targetUuid = logEntry.test_run_uuid as string | undefined
            this.#enqueue('LOG/POST', async () => {
                const instance = targetUuid ? this.#specsByUuid.get(targetUuid) : (this.#openHook ?? this.#lastSpec)
                if (!instance) {
                    return
                }
                const logRecord: Record<string, unknown> = {
                    kind: logEntry.kind ?? TestFrameworkConstants.KIND_LOG,
                    message: Buffer.from(String(logEntry.message ?? '')),
                    level: logEntry.level,
                    timestamp: logEntry.timestamp,
                }
                if (instance === this.#openHook) {
                    logRecord[TestFrameworkConstants.KEY_HOOK_ID] = TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOK_ID)
                }
                // Sent in the instance's own state, not LOG: the binary keys an entry `hook_run_uuid` only when
                // its state is a hook state, so an open all-hook's logs land on the hook.
                if (this.#testHub) {
                    await this.#testHub.sendLogCreatedEvent({ instance, logEntries: [logRecord] })
                }
            })
        } catch (error) {
            logger.error(`WdioJasmineTestFramework: log failed: ${util.format(error)}`)
        }
    }

    #createInstance() {
        const trackedContext = TrackedInstance.createContext(CLIUtils.getCurrentInstanceName())
        const instance = new TestFrameworkInstance(
            trackedContext,
            this.getTestFrameworks(),
            this.getTestFrameworksVersions(),
            TestFrameworkState.NONE,
            HookState.NONE
        )
        const frameworkName = this.getTestFrameworks()[0]
        instance.updateMultipleEntries({
            [TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME]: frameworkName,
            [TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION]: this.getTestFrameworksVersions()[frameworkName],
            [TestFrameworkConstants.KEY_TEST_LOGS]: [],
            [TestFrameworkConstants.KEY_HOOKS_STARTED]: new Map(),
            [TestFrameworkConstants.KEY_HOOKS_FINISHED]: new Map(),
        })
        return instance
    }

    async #toTestHub(instance: TestFrameworkInstance, testFrameworkState: State, hookState: State, args: Record<string, unknown>) {
        const testHub = this.#testHub
        if (!testHub) {
            logger.debug(`WdioJasmineTestFramework: TestHub module not loaded; ${testFrameworkState}/${hookState} not reported`)
            return
        }
        this.updateInstanceState(instance, testFrameworkState, hookState)
        args.instance = instance
        // Legacy sent a run's platform and session with its start event, hooks included (parity #19, #23)
        if (hookState === HookState.PRE) {
            testHub.onBeforeTest(args)
        }
        await testHub.sendTestFrameworkEvent(args)
    }

    async #toModules(instance: TestFrameworkInstance, testFrameworkState: State, hookState: State, args: Record<string, unknown>) {
        args.instance = instance
        args.skipTestHub = true
        await this.runHooks(instance, testFrameworkState, hookState, args)
    }

    /** The reporter's instance for this spec; minted here only when the reporter is not feeding (TO opted out). */
    #serviceInstance(test: { fullName?: string, description?: string, file?: string }) {
        const existing = test.fullName ? this.#specsByFullName.get(test.fullName) : undefined
        if (existing) {
            return existing
        }
        const instance = this.#createInstance()
        instance.updateMultipleEntries({
            [TestFrameworkConstants.KEY_TEST_UUID]: uuidv4(),
            [TestFrameworkConstants.KEY_TEST_RESULT]: TestFrameworkConstants.DEFAULT_TEST_RESULT,
            [TestFrameworkConstants.KEY_TEST_ID]: test.fullName,
            [TestFrameworkConstants.KEY_TEST_NAME]: test.description,
            ...this.#filePaths(test.file),
        })
        this.#serviceOnly.add(instance)
        if (test.fullName) {
            this.#specsByFullName.set(test.fullName, instance)
        }
        return instance
    }

    #enqueue(label: string, step: () => Promise<void>) {
        this.#pendingEvents++
        this.#queue = this.#queue.then(step).catch((error) => {
            logger.error(`WdioJasmineTestFramework: ${label} failed: ${util.format(error)}`)
        }).finally(() => {
            this.#pendingEvents--
        })
    }

    /** The binary re-bases `test_file_path` itself, so it must be absolute. */
    #filePaths(suiteFile: string | undefined) {
        const absolute = suiteFile ? path.resolve(suiteFile) : undefined
        return {
            [TestFrameworkConstants.KEY_TEST_FILE_PATH]: absolute,
            [TestFrameworkConstants.KEY_TEST_LOCATION]: absolute ? path.relative(process.cwd(), absolute) : undefined,
        }
    }

    #failureFields(error: Error): FailureFields {
        return {
            failure: [{ backtrace: [removeAnsiColors(error.message), removeAnsiColors(error.stack || '')] }],
            failureReason: removeAnsiColors(error.message),
            failureType: error.message === null ? null : error.message.toString().match(/AssertionError/) ? 'AssertionError' : 'UnhandledError',
        }
    }

    /** SpecResult-shaped, like the service hooks' `test`: jasmine has no `title`. */
    #specArg(testStats: TestStats, context: JasmineSuiteContext) {
        return { description: testStats.title, fullName: testStats.fullTitle, file: context.suiteFile } as unknown as Frameworks.Test
    }

    /** The describe chain, derived the way `service.beforeTest` does for jasmine. */
    #suiteTitle(testStats: TestStats) {
        const fullName = testStats.fullTitle || ''
        return fullName.slice(0, fullName.indexOf(testStats.title || '') - 1)
    }

    static #hookState(key: string) {
        if (key === 'BEFORE_ALL') {
            return TestFrameworkState.BEFORE_ALL
        }
        if (key === 'AFTER_ALL') {
            return TestFrameworkState.AFTER_ALL
        }
        return null
    }
}
