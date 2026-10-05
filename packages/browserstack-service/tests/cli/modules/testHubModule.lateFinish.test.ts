import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import TestHubModule from '../../../src/cli/modules/testHubModule.js'
import TestFramework from '../../../src/cli/frameworks/testFramework.js'
import { TestFrameworkState } from '../../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../../src/cli/states/hookState.js'
import { GrpcClient } from '../../../src/cli/grpcClient.js'
import { TestFrameworkConstants } from '../../../src/cli/frameworks/constants/testFrameworkConstants.js'
import type { Frameworks } from '@wdio/types'

vi.mock('../../../src/cli/frameworks/testFramework.js', () => ({
    default: {
        registerObserver: vi.fn(),
        getTrackedInstance: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn(),
        hasState: vi.fn()
    }
}))

vi.mock('../../../src/cli/frameworks/automationFramework.js', () => ({
    default: { getTrackedInstance: vi.fn(), getState: vi.fn(), getDriver: vi.fn() }
}))

vi.mock('../../../src/cli/grpcClient.js', () => ({
    GrpcClient: { getInstance: vi.fn() }
}))

vi.mock('../../../src/cli/frameworks/wdioMochaTestFramework.js', () => ({
    default: { getLogEntries: vi.fn(), clearLogs: vi.fn() }
}))

vi.mock('../../../src/cli/cliLogger.js', () => ({
    BStackLogger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}))

// A mock mocha TestFrameworkInstance whose TEST state/hook can be moved PRE -> POST.
function makeMochaTestInstance(uuid: string) {
    const state = { test: TestFrameworkState.TEST, hook: HookState.PRE }
    return {
        __uuid: uuid,
        getContext: () => ({
            getId: () => 'ctx',
            getThreadId: () => 'thread-1',
            getProcessId: () => 'proc-1'
        }),
        getAllData: () => new Map<string, unknown>([
            [TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME, 'WebdriverIO-mocha'],
            [TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION, '9.33.1'],
            [TestFrameworkConstants.KEY_TEST_STARTED_AT, '2026-08-10T20:53:00Z'],
            [TestFrameworkConstants.KEY_TEST_ENDED_AT, '2026-08-10T20:53:02Z']
        ]),
        getRef: () => `ref-${uuid}`,
        updateMultipleEntries: vi.fn(),
        getCurrentTestState: () => state.test,
        getCurrentHookState: () => state.hook,
        state
    }
}

const sendsFor = (grpc: { testFrameworkEvent: ReturnType<typeof vi.fn> }, uuid: string, hook: string) =>
    grpc.testFrameworkEvent.mock.calls.filter(([p]: any[]) => p.uuid === uuid && p.testHookState === hook).length

describe('TestHubModule — a TEST/POST that lands after the worker\'s final flush (SDK-7843)', () => {
    let testHubModule: TestHubModule
    let mockGrpcClient: { testFrameworkEvent: ReturnType<typeof vi.fn> }

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.WDIO_WORKER_ID = '0-1'
        mockGrpcClient = { testFrameworkEvent: vi.fn().mockResolvedValue({ success: true }) }
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
        testHubModule = new TestHubModule({ enabled: true })
    })

    afterEach(() => {
        delete process.env.WDIO_WORKER_ID
    })

    const emit = (instance: ReturnType<typeof makeMochaTestInstance>, hook: State) => {
        instance.state.hook = hook
        testHubModule.onAllTestEvents({ instance, test: { title: 't' } as Frameworks.Test })
    }

    it('sends a timed-out test\'s finish that arrives after service.after() flushed', async () => {
        // A mocha timeout: the test starts, mocha gives up on it and with `bail` the worker's
        // after() runs its flush while the test body is still pending...
        const timedOut = makeMochaTestInstance('timed-out')
        emit(timedOut, HookState.PRE)
        await testHubModule.finishWorker()

        // ...and only then does its afterTest fire. Before the fix this was stashed and never sent.
        emit(timedOut, HookState.POST)
        await testHubModule.awaitLateTestFinishes(1000)

        expect(sendsFor(mockGrpcClient, 'timed-out', 'POST')).toBe(1)
    })

    it('awaitLateTestFinishes waits for a started test whose finish has not arrived yet', async () => {
        const timedOut = makeMochaTestInstance('still-running')
        emit(timedOut, HookState.PRE)
        await testHubModule.finishWorker()

        setTimeout(() => emit(timedOut, HookState.POST), 150)
        await testHubModule.awaitLateTestFinishes(2000)

        expect(sendsFor(mockGrpcClient, 'still-running', 'POST')).toBe(1)
    })

    it('closes a test that never finishes with one synthetic failed finish once the bound expires', async () => {
        const stuck = makeMochaTestInstance('never-finishes')
        emit(stuck, HookState.PRE)
        await testHubModule.finishWorker()

        const t0 = Date.now()
        await testHubModule.awaitLateTestFinishes(200)

        expect(Date.now() - t0).toBeLessThan(1000)
        expect(sendsFor(mockGrpcClient, 'never-finishes', 'POST')).toBe(1)
        expect(stuck.updateMultipleEntries).toHaveBeenCalledWith(expect.objectContaining({
            [TestFrameworkConstants.KEY_TEST_RESULT]: 'failed',
            [TestFrameworkConstants.KEY_TEST_FAILURE_REASON]: TestHubModule.INCOMPLETE_TEST_REASON
        }))
    })

    it('drops a real TEST/POST that straggles in after the synthetic close', async () => {
        const stuck = makeMochaTestInstance('straggler')
        emit(stuck, HookState.PRE)
        await testHubModule.finishWorker()
        await testHubModule.awaitLateTestFinishes(100)

        emit(stuck, HookState.POST)
        await testHubModule.awaitLateTestFinishes(100)

        expect(sendsFor(mockGrpcClient, 'straggler', 'POST')).toBe(1)
    })

    it('waits for a late afterTest\'s bail cascade, not only the timed-out test\'s own finish', async () => {
        const timedOut = makeMochaTestInstance('timed-out-mid-spec')
        const bailSkipped = makeMochaTestInstance('bail-skipped')
        emit(timedOut, HookState.PRE)
        await testHubModule.finishWorker()

        // service.afterTest's CLI branch: TEST/POST, then (after real I/O in other observers)
        // the bail cascade reports the spec's unrun tests as skipped.
        const lateAfterTest = testHubModule.trackLateWork((async () => {
            emit(timedOut, HookState.POST)
            await new Promise((resolve) => setTimeout(resolve, 120))
            emit(bailSkipped, HookState.PRE)
            emit(bailSkipped, HookState.POST)
        })())
        await testHubModule.awaitLateTestFinishes(2000)

        expect(sendsFor(mockGrpcClient, 'timed-out-mid-spec', 'POST')).toBe(1)
        expect(sendsFor(mockGrpcClient, 'bail-skipped', 'POST')).toBe(1)
        await lateAfterTest
    })

    it('does not track work registered before the worker is ending', async () => {
        let release!: () => void
        testHubModule.trackLateWork(new Promise<void>((resolve) => {
            release = resolve
        }))

        await testHubModule.finishWorker()
        const t0 = Date.now()
        await testHubModule.awaitLateTestFinishes(2000)

        expect(Date.now() - t0).toBeLessThan(500)
        release()
    })

    it('still defers a finish during the run, so afterEach custom tags make the payload', () => {
        const passing = makeMochaTestInstance('passing')
        emit(passing, HookState.PRE)
        emit(passing, HookState.POST)

        expect(sendsFor(mockGrpcClient, 'passing', 'POST')).toBe(0)
    })

    it('returns immediately at worker end when every started test has finished', async () => {
        const passing = makeMochaTestInstance('done')
        emit(passing, HookState.PRE)
        emit(passing, HookState.POST)
        await testHubModule.finishWorker()

        const t0 = Date.now()
        await testHubModule.awaitLateTestFinishes(5000)

        expect(Date.now() - t0).toBeLessThan(500)
        expect(sendsFor(mockGrpcClient, 'done', 'POST')).toBe(1)
    })
})
