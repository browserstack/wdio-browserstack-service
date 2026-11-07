import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import TestHubModule from '../../../src/cli/modules/testHubModule.js'
import TestFramework from '../../../src/cli/frameworks/testFramework.js'
import AutomationFramework from '../../../src/cli/frameworks/automationFramework.js'
import TestFrameworkInstance from '../../../src/cli/instances/testFrameworkInstance.js'
import TrackedContext from '../../../src/cli/instances/trackedContext.js'
import { TestFrameworkState } from '../../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../../src/cli/states/hookState.js'
import { GrpcClient } from '../../../src/cli/grpcClient.js'
import { TestFrameworkConstants } from '../../../src/cli/frameworks/constants/testFrameworkConstants.js'

vi.mock('../../../src/cli/grpcClient.js', () => ({
    GrpcClient: { getInstance: vi.fn() }
}))

vi.mock('../../../src/cli/frameworks/automationFramework.js', () => ({
    default: { getTrackedInstance: vi.fn(), getState: vi.fn(), getDriver: vi.fn() }
}))

vi.mock('../../../src/cli/frameworks/wdioMochaTestFramework.js', () => ({
    default: { getLogEntries: vi.fn(() => []), clearLogs: vi.fn() }
}))

vi.mock('../../../src/cli/cliLogger.js', () => ({
    BStackLogger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}))

function makeMochaInstance(uuid: string, testState: State, hookState: State) {
    const instance = new TestFrameworkInstance(new TrackedContext('ctx', 1, 2, 'test'), ['WebdriverIO-mocha'], {}, testState, hookState)
    instance.updateMultipleEntries({
        [TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME]: 'WebdriverIO-mocha',
        [TestFrameworkConstants.KEY_TEST_UUID]: uuid,
        [TestFrameworkConstants.KEY_TEST_RESULT_AT]: '2026-10-26T10:00:00.000Z'
    })
    return instance
}

describe('TestHubModule — acts on the dispatched state, not the shared instance state', () => {
    const framework = new TestFramework(['WebdriverIO-mocha'], { 'WebdriverIO-mocha': '9.32.0' }, 'bin-session')
    // Registered ahead of TestHub, like AutomateModule.onAfterTest, which awaits the session-name
    // PUT when the test body reloaded the session.
    let sessionNamePut: Promise<void> = Promise.resolve()
    let testHubModule: TestHubModule
    let grpc: { testFrameworkEvent: ReturnType<typeof vi.fn>, testSessionEvent: ReturnType<typeof vi.fn>, logCreatedEvent: ReturnType<typeof vi.fn> }

    beforeAll(() => {
        TestFramework.registerObserver(TestFrameworkState.TEST, HookState.POST, () => sessionNamePut)
        testHubModule = new TestHubModule({})
        Object.defineProperty(testHubModule, 'config', { value: { hubUrl: 'https://hub.browserstack.com' }, writable: true })
    })

    beforeEach(() => {
        grpc = {
            testFrameworkEvent: vi.fn().mockResolvedValue({ success: true }),
            testSessionEvent: vi.fn().mockResolvedValue({ success: true }),
            logCreatedEvent: vi.fn().mockResolvedValue({ success: true })
        }
        vi.mocked(GrpcClient.getInstance).mockReturnValue(grpc as never)
    })

    afterEach(() => {
        sessionNamePut = Promise.resolve()
    })

    it('still sends TEST/POST when a LOG is tracked while an earlier TEST/POST observer is awaiting', async () => {
        let releasePut!: () => void
        sessionNamePut = new Promise<void>((resolve) => {
            releasePut = resolve
        })
        const instance = makeMochaInstance('reloaded-test', TestFrameworkState.TEST, HookState.POST)

        const dispatch = framework.runHooks(instance, TestFrameworkState.TEST, HookState.POST, { instance, test: { title: 'reloads the session' } })
        // the user's afterTest screenshot is tracked on the same instance while the PUT is in flight
        framework.updateInstanceState(instance, TestFrameworkState.LOG, HookState.POST)
        releasePut()
        await dispatch
        await testHubModule.flushPendingTestFinishEvent()

        expect(grpc.testFrameworkEvent).toHaveBeenCalledTimes(1)
        expect(grpc.testFrameworkEvent).toHaveBeenCalledWith(
            expect.objectContaining({ testFrameworkState: 'TEST', testHookState: 'POST', uuid: 'reloaded-test' })
        )
    })

    it.each([
        [TestFrameworkState.TEST, HookState.PRE, 'TEST', 'PRE'],
        [TestFrameworkState.AFTER_EACH, HookState.POST, 'AFTER_EACH', 'POST']
    ])('sends %s/%s with its own state after the instance has moved on to LOG', (testState, hookState, wireState, wireHook) => {
        const instance = makeMochaInstance('moved-on', TestFrameworkState.LOG, HookState.POST)

        testHubModule.onAllTestEvents({ instance, testFrameworkState: testState, hookState })

        expect(grpc.testFrameworkEvent).toHaveBeenCalledTimes(1)
        expect(grpc.testFrameworkEvent).toHaveBeenCalledWith(
            expect.objectContaining({ testFrameworkState: wireState, testHookState: wireHook, uuid: 'moved-on' })
        )
    })

    it('reports TEST/PRE on the test session event after the instance has moved on to LOG', () => {
        vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue({ getRef: () => 'auto-ref', frameworkName: 'webdriverio', frameworkVersion: '9.32.0' } as never)
        vi.mocked(AutomationFramework.getDriver).mockReturnValue({ capabilities: {} } as never)
        vi.mocked(AutomationFramework.getState).mockReturnValue('session-id' as never)
        const instance = makeMochaInstance('moved-on', TestFrameworkState.LOG, HookState.POST)

        testHubModule.onBeforeTest({ instance, testFrameworkState: TestFrameworkState.TEST, hookState: HookState.PRE })

        expect(grpc.testSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ testFrameworkState: 'TEST', testHookState: 'PRE', testUuid: 'moved-on' })
        )
    })

    it('turns a LOG_REPORT/POST recovery into exactly one deferred TEST/POST', async () => {
        const instance = makeMochaInstance('late-result', TestFrameworkState.LOG_REPORT, HookState.POST)
        instance.updateMultipleEntries({ [TestFrameworkConstants.KEY_TEST_DEFERRED]: true })

        testHubModule.onAllTestEvents({ instance, testFrameworkState: TestFrameworkState.LOG_REPORT, hookState: HookState.POST })
        await testHubModule.flushPendingTestFinishEvent()

        expect(grpc.testFrameworkEvent).toHaveBeenCalledTimes(1)
        expect(grpc.testFrameworkEvent).toHaveBeenCalledWith(
            expect.objectContaining({ testFrameworkState: 'TEST', testHookState: 'POST', uuid: 'late-result' })
        )
    })
})
