import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TestFrameworkConstants } from '../../src/cli/frameworks/constants/testFrameworkConstants.js'
import type { Frameworks } from '@wdio/types'

vi.mock('../../src/cli/frameworks/testFramework.js', () => ({
    default: {
        registerObserver: vi.fn(),
        getTrackedInstance: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn(),
        hasState: vi.fn()
    }
}))

vi.mock('../../src/cli/frameworks/automationFramework.js', () => ({
    default: { getTrackedInstance: vi.fn(), getState: vi.fn(), getDriver: vi.fn() }
}))

vi.mock('../../src/cli/grpcClient.js', () => ({
    GrpcClient: { getInstance: vi.fn() }
}))

vi.mock('../../src/cli/frameworks/wdioMochaTestFramework.js', () => ({
    default: { getLogEntries: vi.fn(), clearLogs: vi.fn() }
}))

vi.mock('../../src/cli/cliLogger.js', () => ({
    BStackLogger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}))

vi.mock('../../src/bstackLogger.js', () => ({
    BStackLogger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}))

/**
 * SDK-7493 — `describe.skip()` leaves a test stuck "In Progress" and the build is reaped
 * as `timeout` ~60 min later.
 *
 * WDIO does not await reporter hooks, so `onTestSkip` -> `reportSkippedTest` runs detached
 * on the skipReporter's module-level `reportChain`. That chain ends by emitting mocha
 * TEST/POST, which TestHubModule does NOT send — it *stashes* it in the single-slot
 * `pendingTestFinish`, to be flushed either at the next test's boundary or from
 * `service.after()`.
 *
 * With `describe.skip()` there IS no next test, so `service.after()` is the only flush
 * opportunity — and it must drain the skip chain BEFORE flushing, or it flushes an empty
 * slot and the stash that lands moments later is never sent.
 */
describe('service.after() ordering — skip-report drain vs deferred-finish flush (SDK-7493)', () => {
    let mockGrpcClient: { testFrameworkEvent: ReturnType<typeof vi.fn> }

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.WDIO_WORKER_ID = '0-1'
        mockGrpcClient = { testFrameworkEvent: vi.fn().mockResolvedValue({ success: true }) }
    })

    afterEach(() => {
        vi.resetAllMocks()
        delete process.env.WDIO_WORKER_ID
    })

    /**
     * Build a fresh skipReporter + TestHubModule pair wired the way the tracker wires them:
     * every trackEvent reaches the module's onAllTestEvents observer.
     *
     * skipReporter keeps its chain/dedupe sets at module level, so each case needs its own
     * module registry. Everything — mocks AND the state enums — must therefore be resolved
     * from THAT registry: `TestFrameworkState.TEST` et al are frozen *object* references,
     * so a copy from another graph would fail every `===` inside the module under test.
     */
    async function wireSkipReporterToModule() {
        vi.resetModules()
        const { GrpcClient } = await import('../../src/cli/grpcClient.js')
        const { default: TestFramework } = await import('../../src/cli/frameworks/testFramework.js')
        const { TestFrameworkState } = await import('../../src/cli/states/testFrameworkState.js')
        const { HookState } = await import('../../src/cli/states/hookState.js')
        const { default: TestHubModule } = await import('../../src/cli/modules/testHubModule.js')
        const skipReporter = await import('../../src/cli/skipReporter.js')

        vi.mocked(GrpcClient.getInstance).mockReturnValue(mockGrpcClient as never)
        vi.mocked(TestFramework.hasState).mockReturnValue(true)
        vi.mocked(TestFramework.getState).mockImplementation((instance: any, key: unknown) => {
            if (key === TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME) {
                return 'WebdriverIO-mocha'
            }
            if (key === TestFrameworkConstants.KEY_TEST_DEFERRED) {
                return false
            }
            if (key === TestFrameworkConstants.KEY_TEST_UUID) {
                return instance?.__uuid
            }
            return ''
        })

        const testHubModule = new TestHubModule({ enabled: true, hubUrl: 'https://hub.browserstack.com' })

        // A skipped test's instance, as the tracker would hand it to the module at TEST/POST.
        const makeInstance = (uuid: string) => ({
            __uuid: uuid,
            getContext: () => ({
                getId: () => 'ctx',
                getThreadId: () => 'thread-1',
                getProcessId: () => 'proc-1'
            }),
            getAllData: () => new Map<string, unknown>([
                [TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME, 'WebdriverIO-mocha'],
                [TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION, '9.35.1'],
                [TestFrameworkConstants.KEY_TEST_STARTED_AT, '2026-09-02T01:00:00Z'],
                [TestFrameworkConstants.KEY_TEST_ENDED_AT, '2026-09-02T01:00:00Z']
            ]),
            getRef: () => `ref-${uuid}`,
            getCurrentTestState: () => TestFrameworkState.TEST,
            getCurrentHookState: () => HookState.POST
        })

        // The real tracker mints a fresh instance per test and dispatches to observers; the
        // only event that matters here is each report's terminal mocha TEST/POST.
        let seq = 0
        const framework = {
            trackEvent: vi.fn(async (state: unknown, hook: unknown, data: Record<string, unknown>) => {
                await Promise.resolve()
                if (state === TestFrameworkState.INIT_TEST && hook === HookState.PRE) {
                    seq += 1
                }
                if (state === TestFrameworkState.TEST && hook === HookState.POST) {
                    testHubModule.onAllTestEvents({ ...data, instance: makeInstance(`skip-${seq}`) })
                }
            })
        }

        return { testHubModule, skipReporter, framework }
    }

    function sentFinishes() {
        return mockGrpcClient.testFrameworkEvent.mock.calls
            .map(([payload]) => payload as { testFrameworkState: string, testHookState: string })
            .filter((p) => p.testFrameworkState === 'TEST' && p.testHookState === 'POST')
    }

    const skippedTest = { title: 'is skipped', parent: 'skipped suite' } as unknown as Frameworks.Test

    it('flushing before the drain loses the skipped test\'s TestRunFinished (the SDK-7493 defect)', async () => {
        const { testHubModule, skipReporter, framework } = await wireSkipReporterToModule()

        // WDIO does not await onTestSkip — the report is queued, not completed.
        void skipReporter.reportSkippedTest(framework as never, 'skipped suite - is skipped', skippedTest, 'skipped suite')

        // service.after(), in the order shipped in 9.35.1: flush (service.ts:658) then drain (:666).
        await testHubModule.flushPendingTestFinishEvent()
        await skipReporter.drainSkipReports()

        // The flush ran against an empty slot; the stash landed during the drain and no
        // further flush follows before worker teardown.
        expect(sentFinishes()).toHaveLength(0)
    })

    it('draining before the flush delivers it — the skipped test terminalizes', async () => {
        const { testHubModule, skipReporter, framework } = await wireSkipReporterToModule()

        void skipReporter.reportSkippedTest(framework as never, 'skipped suite - is skipped', skippedTest, 'skipped suite')

        // service.after(), corrected order: drain the detached skip chain first so its
        // TEST/POST is stashed, then flush.
        await skipReporter.drainSkipReports()
        await testHubModule.flushPendingTestFinishEvent()

        expect(sentFinishes()).toHaveLength(1)
        expect(sentFinishes()[0].testFrameworkState).toBe('TEST')
        expect(sentFinishes()[0].testHookState).toBe('POST')
    })

    it('drain-then-flush delivers every test when a whole suite is skipped (describe.skip)', async () => {
        const { testHubModule, skipReporter, framework } = await wireSkipReporterToModule()

        // describe.skip() — several tests skip back to back, all on the one detached chain.
        for (const title of ['first', 'second', 'third']) {
            void skipReporter.reportSkippedTest(
                framework as never,
                `skipped suite - ${title}`,
                { title, parent: 'skipped suite' } as unknown as Frameworks.Test,
                'skipped suite'
            )
        }

        await skipReporter.drainSkipReports()
        await testHubModule.flushPendingTestFinishEvent()

        // Each report gets its own instance, so an arriving report flushes its predecessor
        // and service.after() flushes the last one.
        expect(sentFinishes()).toHaveLength(3)
    })
})
