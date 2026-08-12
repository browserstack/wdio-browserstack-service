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
    // A transient gRPC failure is swallowed with no retry, so the TestRunFinished never reaches the
    // binary/backend. The test then stays "in progress" and is reaped by Test Hub's ~60-min per-test
    // timeout (TEST_TIMED_OUT_WITH_BUILD_SUCCESS), which stamps the whole build `timeout`.
    it('does not drop the last-test finish on a transient send failure (retries until delivered)', async () => {
        const inst = makeMochaTestInstance('last')
        testHubModule.onAllTestEvents({ instance: inst, test: { title: 'last' } as Frameworks.Test })

        // First attempt fails transiently, second succeeds.
        mockGrpcClient.testFrameworkEvent
            .mockRejectedValueOnce(new Error('transient gRPC failure'))
            .mockResolvedValueOnce({ success: true })

        await testHubModule.flushPendingTestFinishEvent()

        // Must be retried and ultimately delivered — otherwise the test is orphaned.
        expect(mockGrpcClient.testFrameworkEvent).toHaveBeenCalledTimes(2)
    })

    it('clears the pending finish after a flush so it is never sent twice', async () => {
        const inst = makeMochaTestInstance('t1')
        testHubModule.onAllTestEvents({ instance: inst, test: { title: 't1' } as Frameworks.Test })

        await testHubModule.flushPendingTestFinishEvent()
        await testHubModule.flushPendingTestFinishEvent() // second flush is a no-op

        expect(mockGrpcClient.testFrameworkEvent).toHaveBeenCalledTimes(1)
    })
})
