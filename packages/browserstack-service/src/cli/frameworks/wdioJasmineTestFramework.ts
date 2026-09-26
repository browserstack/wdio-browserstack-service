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
 * Test and hook states come from the WDIO reporter (`reporter.ts`), the only jasmine source that
 * sees pending, focused-out and beforeAll-failed specs. Reporter hooks are not awaited by WDIO, so
 * every reporter event is applied and dispatched through one ordered queue.
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

    static #pendingEvents = 0

    #specInstances = new Map<string, TestFrameworkInstance>()
    // beforeAll/afterAll never overlap, so a hook's uid (its title) is unique while it is open.
    #hookInstances = new Map<string, TestFrameworkInstance>()
    #openHook: TestFrameworkInstance | null = null
    #lastSpec: TestFrameworkInstance | null = null
    #queue: Promise<void> = Promise.resolve()

    constructor(testFrameworks: string[], testFrameworkVersions: Record<string, string>, binSessionId: string) {
        super(testFrameworks, testFrameworkVersions, binSessionId)
        logger.debug('WdioJasmineTestFramework: constructed')
    }

    /** True when no reporter event is still waiting to be dispatched (the reporter's `isSynchronised`). */
    static isIdle() {
        return WdioJasmineTestFramework.#pendingEvents === 0
    }

    /**
     * Service hooks (beforeTest/afterTest and friends) also call this. Their TEST/INIT_TEST/LOG_REPORT
     * states would duplicate what the reporter already dispatched, so they are absorbed; waiting for the
     * queue first leaves the tracked instance pointing at the spec the service is running.
     */
    async trackEvent(testFrameworkState: State, hookState: State, args: Record<string, unknown> = {}) {
        if (testFrameworkState === TestFrameworkState.LOG) {
            this.onReporterLog(args.logEntry as Record<string, unknown>)
            return
        }
        await this.#queue
        logger.debug(`WdioJasmineTestFramework: absorbed service event ${testFrameworkState}/${hookState}`)
    }

    onReporterTestStart(testStats: TestStats, context: JasmineSuiteContext) {
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
                [TestFrameworkConstants.KEY_TEST_STARTED_AT]: this.#iso(testStats.start),
                [WdioJasmineTestFramework.KEY_TEST_DURATION]: testStats._duration,
                [WdioJasmineTestFramework.KEY_TEST_RETRIES]: { limit: testStats.retries || 0, attempts: testStats.retries || 0 },
            })
            this.#specInstances.set(testStats.uid, instance)
            // Registered synchronously: the service's beforeTest for this spec may read it before the queue runs.
            TestFramework.setTrackedInstance(instance.getContext(), instance)

            const args = { test: this.#specArg(testStats, context), suiteTitle: this.#suiteTitle(testStats) }
            this.#enqueue('TEST/PRE', async () => {
                this.#lastSpec = instance
                process.env[TEST_ANALYTICS_ID] = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_UUID)
                await this.#emit(instance, TestFrameworkState.TEST, HookState.PRE, args)
            })
            return TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_UUID) as string
        } catch (error) {
            logger.error(`WdioJasmineTestFramework: test start failed: ${util.format(error)}`)
        }
    }

    onReporterTestEnd(testStats: TestStats, context: JasmineSuiteContext) {
        try {
            const instance = this.#specInstances.get(testStats.uid)
            if (!instance) {
                logger.debug(`WdioJasmineTestFramework: no instance for test end uid=${testStats.uid}`)
                return
            }
            this.#specInstances.delete(testStats.uid)

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
                [TestFrameworkConstants.KEY_TEST_STARTED_AT]: this.#iso(testStats.start),
                [TestFrameworkConstants.KEY_TEST_ENDED_AT]: this.#iso(testStats.end),
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
                await this.#emit(instance, TestFrameworkState.TEST, HookState.POST, args)
            })
        } catch (error) {
            logger.error(`WdioJasmineTestFramework: test end failed: ${util.format(error)}`)
        }
    }

    onReporterHookStart(hookStats: HookStats, context: JasmineSuiteContext) {
        try {
            const title = hookStats.title
            const key = getHookType(String(title ?? '').toLowerCase())
            const hookFrameworkState = WdioJasmineTestFramework.#hookState(key)
            if (!hookFrameworkState || context.scopes.length === 0) {
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
                [TestFrameworkConstants.KEY_EVENT_STARTED_AT]: this.#iso(hookStats.start),
                [TestFrameworkConstants.KEY_HOOK_LOGS]: [],
                [TestFrameworkConstants.KEY_HOOK_NAME]: title,
                [WdioJasmineTestFramework.KEY_HOOK_IDENTIFIER]: `${title} for ${scopes[scopes.length - 1]}`,
                [WdioJasmineTestFramework.KEY_HOOK_SCOPE]: `${scopes[0]} - ${title}`,
                [WdioJasmineTestFramework.KEY_HOOK_SCOPES]: scopes,
                [WdioJasmineTestFramework.KEY_HOOK_DURATION]: hookStats._duration,
                ...this.#filePaths(context.suiteFile),
            }
            instance.updateData(TestFrameworkConstants.KEY_HOOK_ID, hookId)
            this.#hookInstances.set(hookStats.uid, instance)

            const emitHook = shouldProcessEventForTesthub('HookRunStarted')
            this.#enqueue(`${key}/PRE`, async () => {
                this.#openHook = instance
                const hooksStarted = TestFramework.getState(instance, TestFrameworkConstants.KEY_HOOKS_STARTED) as Map<string, unknown[]>
                hooksStarted.set(key, [hook])
                instance.updateData(WdioJasmineTestFramework.KEY_HOOK_LAST_STARTED, key)
                if (emitHook) {
                    await this.#emit(instance, hookFrameworkState, HookState.PRE, { hook: hookStats })
                }
            })
        } catch (error) {
            logger.error(`WdioJasmineTestFramework: hook start failed: ${util.format(error)}`)
        }
    }

    onReporterHookEnd(hookStats: HookStats) {
        try {
            const instance = this.#hookInstances.get(hookStats.uid)
            if (!instance) {
                return
            }
            this.#hookInstances.delete(hookStats.uid)
            const key = getHookType(String(hookStats.title ?? '').toLowerCase())
            const hookFrameworkState = WdioJasmineTestFramework.#hookState(key)!

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
            const endedAt = this.#iso(hookStats.end)
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
                    await this.#emit(instance, hookFrameworkState, HookState.POST, { hook: hookStats, result: { passed: result === 'passed', error } })
                }
            })
        } catch (error) {
            logger.error(`WdioJasmineTestFramework: hook end failed: ${util.format(error)}`)
        }
    }

    /** Console logs and screenshots: an open beforeAll/afterAll wins, else the last-started spec, even after it ended. */
    onReporterLog(logEntry: Record<string, unknown> | undefined) {
        try {
            if (!logEntry || !shouldProcessEventForTesthub('LogCreated')) {
                return
            }
            this.#enqueue('LOG/POST', async () => {
                const instance = this.#openHook ?? this.#lastSpec
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
                const entries = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_LOGS) as unknown[]
                entries.push(logRecord)
                await this.#emit(instance, TestFrameworkState.LOG, HookState.POST, { logEntry })
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

    async #emit(instance: TestFrameworkInstance, testFrameworkState: State, hookState: State, args: Record<string, unknown>) {
        TestFramework.setTrackedInstance(instance.getContext(), instance)
        this.updateInstanceState(instance, testFrameworkState, hookState)
        args.instance = instance
        await this.runHooks(instance, testFrameworkState, hookState, args)
    }

    #enqueue(label: string, step: () => Promise<void>) {
        WdioJasmineTestFramework.#pendingEvents++
        this.#queue = this.#queue.then(step).catch((error) => {
            logger.error(`WdioJasmineTestFramework: ${label} failed: ${util.format(error)}`)
        }).finally(() => {
            WdioJasmineTestFramework.#pendingEvents--
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

    #iso(date: Date | undefined) {
        return date ? date.toISOString() : undefined
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
