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

// Build a mock TestFrameworkInstance sitting at mocha TEST/POST (a finished test whose
// TestRunFinished the module defers past the after-each window).
function makeMochaTestInstance(uuid: string) {
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
        getCurrentTestState: () => TestFrameworkState.TEST,
        getCurrentHookState: () => HookState.POST
    }
}

describe('TestHubModule — deferred last-test-finish delivery (SDK-7265)', () => {
    let testHubModule: TestHubModule
    let mockGrpcClient: { testFrameworkEvent: ReturnType<typeof vi.fn> }

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.WDIO_WORKER_ID = '0-1'

        mockGrpcClient = { testFrameworkEvent: vi.fn().mockResolvedValue({ success: true }) }
        vi.mocked(GrpcClient.getInstance).mockReturnValue(mockGrpcClient as never)

        // KEY_TEST_RESULT_AT present (so onAllTestEvents does not take the "no results" path);
        // framework name resolves to mocha; uuid echoes the instance.
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

        testHubModule = new TestHubModule({ enabled: true, hubUrl: 'https://hub.browserstack.com' })
        Object.defineProperty(testHubModule, 'config', {
            value: { hubUrl: 'https://hub.browserstack.com' },
            writable: true
        })
    })

    afterEach(() => {
        vi.resetAllMocks()
        delete process.env.WDIO_WORKER_ID
    })

    it('defers a mocha TEST/POST instead of sending it immediately', () => {
        const inst = makeMochaTestInstance('t1')
        testHubModule.onAllTestEvents({ instance: inst, test: { title: 't1' } as Frameworks.Test })
        // Held for the after-each window — not yet on the wire.
        expect(mockGrpcClient.testFrameworkEvent).not.toHaveBeenCalled()
    })

    it('delivers the deferred finish when the flush send succeeds', async () => {
        const inst = makeMochaTestInstance('t1')
        testHubModule.onAllTestEvents({ instance: inst, test: { title: 't1' } as Frameworks.Test })

        await testHubModule.flushPendingTestFinishEvent()

        expect(mockGrpcClient.testFrameworkEvent).toHaveBeenCalledTimes(1)
        expect(mockGrpcClient.testFrameworkEvent).toHaveBeenCalledWith(
            expect.objectContaining({ testFrameworkState: 'TEST', testHookState: 'POST', uuid: 't1' })
        )
    })

    // REPRODUCTION: the worker's last test relies on this single best-effort flush (service.after()).
    // A transient gRPC failure was swallowed with no retry, so the TestRunFinished never reached the
    // binary/backend. The test then stays "in progress" and is reaped by Test Hub's ~60-min per-test
    // timeout (TEST_TIMED_OUT_WITH_BUILD_SUCCESS), which stamps the whole build `timeout`.
    it('does not drop the last-test finish on a transient send failure — retries the SAME finish until delivered', async () => {
        const inst = makeMochaTestInstance('last')
        testHubModule.onAllTestEvents({ instance: inst, test: { title: 'last' } as Frameworks.Test })

        // First attempt fails transiently, second succeeds.
        mockGrpcClient.testFrameworkEvent
            .mockRejectedValueOnce(new Error('transient gRPC failure'))
            .mockResolvedValueOnce({ success: true })

        await testHubModule.flushPendingTestFinishEvent()

        // Retried (not a single fixed attempt) AND every attempt re-sends the same test's finish —
        // distinguishes a real retry-until-delivered from a regressed single-shot send.
        expect(mockGrpcClient.testFrameworkEvent).toHaveBeenCalledTimes(2)
        for (const call of mockGrpcClient.testFrameworkEvent.mock.calls) {
            expect(call[0]).toMatchObject({ uuid: 'last', testFrameworkState: 'TEST', testHookState: 'POST' })
        }
    })

    it('drives the retry budget to exhaustion on sustained failure, then gives up cleanly without re-stashing', async () => {
        const inst = makeMochaTestInstance('exhaust')
        testHubModule.onAllTestEvents({ instance: inst, test: { title: 'exhaust' } as Frameworks.Test })

        mockGrpcClient.testFrameworkEvent.mockRejectedValue(new Error('sustained gRPC outage'))

        await expect(testHubModule.flushPendingTestFinishEvent()).resolves.toBeUndefined()

        // All three attempts ran, each re-sending the same finish.
        expect(mockGrpcClient.testFrameworkEvent).toHaveBeenCalledTimes(3)
        for (const call of mockGrpcClient.testFrameworkEvent.mock.calls) {
            expect(call[0]).toMatchObject({ uuid: 'exhaust' })
        }
        // An exhausted event must NOT be re-stashed into the shared slot — re-stashing races the
        // fire-and-forget flush call sites and can drop a newer test's finish (SDK-7265 review #1).
        expect((testHubModule as unknown as { pendingTestFinish: unknown }).pendingTestFinish).toBeNull()
        expect(testHubModule.logger.error).toHaveBeenCalledWith(
            expect.stringContaining('failed after all retries')
        )
    })

    it('concurrent flushes each deliver their own finish — a retrying older flush never drops a newer test', async () => {
        let aAttempts = 0
        mockGrpcClient.testFrameworkEvent.mockImplementation((payload: { uuid: string }) => {
            if (payload.uuid === 'A') {
                aAttempts += 1
                if (aAttempts === 1) {
                    return Promise.reject(new Error('transient on A'))
                }
            }
            return Promise.resolve({ success: true })
        })

        // Test A finishes, is deferred, then flushed fire-and-forget (as the next-test boundary does).
        testHubModule.onAllTestEvents({ instance: makeMochaTestInstance('A'), test: { title: 'A' } as Frameworks.Test })
        const flushA = testHubModule.flushPendingTestFinishEvent() // not awaited — A is retrying

        // While A retries, test B finishes, is deferred and flushed.
        testHubModule.onAllTestEvents({ instance: makeMochaTestInstance('B'), test: { title: 'B' } as Frameworks.Test })
        await testHubModule.flushPendingTestFinishEvent() // B
        await flushA

        const sent = mockGrpcClient.testFrameworkEvent.mock.calls.map((c: unknown[]) => (c[0] as { uuid: string }).uuid)
        expect(sent.filter((u) => u === 'A').length).toBe(2) // 1 transient fail + 1 retry success
        expect(sent.filter((u) => u === 'B').length).toBe(1) // delivered once, never dropped
    })

    it('clears the pending finish after a flush so it is never sent twice', async () => {
        const inst = makeMochaTestInstance('t1')
        testHubModule.onAllTestEvents({ instance: inst, test: { title: 't1' } as Frameworks.Test })

        await testHubModule.flushPendingTestFinishEvent()
        await testHubModule.flushPendingTestFinishEvent() // second flush is a no-op

        expect(mockGrpcClient.testFrameworkEvent).toHaveBeenCalledTimes(1)
    })
})
