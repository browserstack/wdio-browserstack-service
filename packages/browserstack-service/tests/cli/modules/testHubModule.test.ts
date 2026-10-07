import { EventEmitter } from 'node:events'
import type { Mock } from 'vitest'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import TestHubModule from '../../../src/cli/modules/testHubModule.js'
import TestFramework from '../../../src/cli/frameworks/testFramework.js'
import AutomationFramework from '../../../src/cli/frameworks/automationFramework.js'
import { TestFrameworkState } from '../../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../../src/cli/states/hookState.js'
import { GrpcClient } from '../../../src/cli/grpcClient.js'
import WdioMochaTestFramework from '../../../src/cli/frameworks/wdioMochaTestFramework.js'
import { TestFrameworkConstants } from '../../../src/cli/frameworks/constants/testFrameworkConstants.js'
import { AutomationFrameworkConstants } from '../../../src/cli/frameworks/constants/automationFrameworkConstants.js'
import type { Frameworks } from '@wdio/types'
import { BStackLogger } from '../../../src/cli/cliLogger.js'

// Mock all dependencies
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
    default: {
        getTrackedInstance: vi.fn(),
        getState: vi.fn(),
        getDriver: vi.fn(),
        registerObserver: vi.fn()
    }
}))

vi.mock('../../../src/cli/grpcClient.js', () => ({
    GrpcClient: {
        getInstance: vi.fn(() => ({
            testFrameworkEvent: vi.fn(),
            testSessionEvent: vi.fn(),
            logCreatedEvent: vi.fn()
        }))
    }
}))

vi.mock('../../../src/cli/frameworks/wdioMochaTestFramework.js', () => ({
    default: {
        getLogEntries: vi.fn(),
        clearLogs: vi.fn()
    }
}))

vi.mock('../../../src/cli/cliLogger.js', () => ({
    BStackLogger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
    }
}))

describe('TestHubModule', () => {
    let testHubModule: TestHubModule
    let mockTesthubConfig: any
    let mockGrpcClient: any
    let registerObserverSpy: Mock

    beforeEach(() => {
        vi.clearAllMocks()

        // Setup mock config
        mockTesthubConfig = {
            enabled: true,
            hubUrl: 'https://hub.browserstack.com'
        }

        // Setup mock gRPC client
        mockGrpcClient = {
            testFrameworkEvent: vi.fn().mockResolvedValue({ success: true }),
            testSessionEvent: vi.fn().mockResolvedValue({ success: true }),
            logCreatedEvent: vi.fn().mockResolvedValue({ success: true })
        }

        // Mock static methods - reset them fresh each time
        registerObserverSpy = vi.mocked(TestFramework.registerObserver).mockImplementation(() => {})
        vi.mocked(GrpcClient.getInstance).mockReturnValue(mockGrpcClient)

        // Set environment variable
        process.env.WDIO_WORKER_ID = '0-1'

        // Create module instance
        testHubModule = new TestHubModule(mockTesthubConfig)

        // Mock config property
        Object.defineProperty(testHubModule, 'config', {
            value: mockTesthubConfig,
            writable: true
        })
    })

    afterEach(() => {
        vi.resetAllMocks()
        delete process.env.WDIO_WORKER_ID
    })

    describe('constructor', () => {
        it('should initialize TestHubModule correctly', () => {
            expect(testHubModule.name).toBe('TestHubModule')
            expect(testHubModule.testhubConfig).toBe(mockTesthubConfig)
        })

        it('should register observers for test events', () => {
            // Reset and create new instance to check registration calls
            registerObserverSpy.mockClear()
            new TestHubModule(mockTesthubConfig)

            expect(TestFramework.registerObserver).toHaveBeenCalledWith(
                TestFrameworkState.TEST,
                HookState.PRE,
                expect.any(Function)
            )

            // Should register for all test states and hook states (11*3) + 1 specific registration for onBeforeTest
            const expectedCalls = Object.values(TestFrameworkState).length * Object.values(HookState).length + 1
            expect(TestFramework.registerObserver).toHaveBeenCalledTimes(expectedCalls)
        })

        it('should have correct module name', () => {
            expect(testHubModule.getModuleName()).toBe('TestHubModule')
            expect(TestHubModule.MODULE_NAME).toBe('TestHubModule')
        })
    })

    describe('onBeforeTest', () => {
        it('should call sendTestSessionEvent with automation instance', async () => {
            const mockAutomationInstance = {
                getRef: vi.fn(() => 'auto-ref'),
                frameworkName: 'webdriverio',
                frameworkVersion: '7.0.0',
                getAllData: vi.fn(() => new Map())
            }

            vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue(mockAutomationInstance)
            const sendTestSessionEventSpy = vi.spyOn(testHubModule, 'sendTestSessionEvent').mockResolvedValue()

            const mockArgs = {
                test: { title: 'Test Login Functionality' } as Frameworks.Test,
                suiteTitle: 'Login Suite'
            }

            await testHubModule.onBeforeTest(mockArgs)

            expect(sendTestSessionEventSpy).toHaveBeenCalledWith({
                ...mockArgs,
                autoInstance: [mockAutomationInstance]
            })
        })

        it('should skip events marked skipTestHub', async () => {
            const sendTestSessionEventSpy = vi.spyOn(testHubModule, 'sendTestSessionEvent').mockResolvedValue()

            await testHubModule.onBeforeTest({ test: { title: 'Test' } as Frameworks.Test, skipTestHub: true })

            expect(AutomationFramework.getTrackedInstance).not.toHaveBeenCalled()
            expect(sendTestSessionEventSpy).not.toHaveBeenCalled()
        })
    })

    describe('onAllTestEvents', () => {
        it('should handle LOG state and send log created event', async () => {
            const mockInstance = {
                getCurrentTestState: vi.fn(() => TestFrameworkState.LOG),
                getCurrentHookState: vi.fn(() => HookState.PRE)
            }

            const mockLogEntries = [
                { kind: 'console', message: new Uint8Array([1, 2, 3]), timestamp: '2023-06-01T10:00:00Z', level: 'info' }
            ]

            vi.mocked(WdioMochaTestFramework.getLogEntries).mockReturnValue(mockLogEntries)
            const sendLogCreatedEventSpy = vi.spyOn(testHubModule, 'sendLogCreatedEvent').mockResolvedValue()

            const mockArgs = {
                instance: mockInstance,
                test: { title: 'Test' } as Frameworks.Test
            }

            await testHubModule.onAllTestEvents(mockArgs)

            expect(WdioMochaTestFramework.getLogEntries).toHaveBeenCalledWith(
                mockInstance,
                TestFrameworkState.LOG,
                HookState.PRE
            )
            expect(sendLogCreatedEventSpy).toHaveBeenCalledWith({
                ...mockArgs,
                logEntries: mockLogEntries
            })
        })

        it('should handle TEST state without results and set deferred flag', async () => {
            const mockInstance = {
                getCurrentTestState: vi.fn(() => TestFrameworkState.TEST),
                getCurrentHookState: vi.fn(() => HookState.POST)
            }

            vi.mocked(TestFramework.hasState).mockReturnValue(false)

            const mockArgs = {
                instance: mockInstance,
                test: { title: 'Test' } as Frameworks.Test
            }

            await testHubModule.onAllTestEvents(mockArgs)

            expect(TestFramework.setState).toHaveBeenCalledWith(
                mockInstance,
                TestFrameworkConstants.KEY_TEST_DEFERRED,
                true
            )
        })

        it('should send test framework event for TEST state', async () => {
            const mockInstance = {
                getCurrentTestState: vi.fn(() => TestFrameworkState.TEST),
                getCurrentHookState: vi.fn(() => HookState.PRE)
            }

            const sendTestFrameworkEventSpy = vi.spyOn(testHubModule, 'sendTestFrameworkEvent').mockResolvedValue()

            const mockArgs = {
                instance: mockInstance,
                test: { title: 'Test' } as Frameworks.Test
            }

            await testHubModule.onAllTestEvents(mockArgs)

            expect(sendTestFrameworkEventSpy).toHaveBeenCalledWith(mockArgs)
        })

        it('should skip events marked skipTestHub', async () => {
            const mockInstance = {
                getCurrentTestState: vi.fn(() => TestFrameworkState.TEST),
                getCurrentHookState: vi.fn(() => HookState.POST)
            }
            const sendTestFrameworkEventSpy = vi.spyOn(testHubModule, 'sendTestFrameworkEvent').mockResolvedValue()

            await testHubModule.onAllTestEvents({ instance: mockInstance, skipTestHub: true })

            expect(mockInstance.getCurrentTestState).not.toHaveBeenCalled()
            expect(sendTestFrameworkEventSpy).not.toHaveBeenCalled()
        })

        it('should only treat a literal true skipTestHub as the marker', async () => {
            const mockInstance = {
                getCurrentTestState: vi.fn(() => TestFrameworkState.TEST),
                getCurrentHookState: vi.fn(() => HookState.PRE)
            }
            const sendTestFrameworkEventSpy = vi.spyOn(testHubModule, 'sendTestFrameworkEvent').mockResolvedValue()
            const mockArgs = { instance: mockInstance, skipTestHub: 'true' }

            await testHubModule.onAllTestEvents(mockArgs)

            expect(sendTestFrameworkEventSpy).toHaveBeenCalledWith(mockArgs)
        })
    })

    describe('sendTestFrameworkEvent', () => {
        it('should send test framework event successfully', async () => {
            const mockContext = {
                getId: vi.fn(() => 'test-context-id'),
                getThreadId: vi.fn(() => 'thread-123'),
                getProcessId: vi.fn(() => 'process-456')
            }

            const mockInstance = {
                getContext: vi.fn(() => mockContext),
                getAllData: vi.fn(() => new Map([
                    [TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME, 'mocha'],
                    [TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION, '8.0.0'],
                    [TestFrameworkConstants.KEY_TEST_STARTED_AT, '2023-06-01T10:00:00Z'],
                    [TestFrameworkConstants.KEY_TEST_ENDED_AT, '2023-06-01T10:01:00Z']
                ])),
                getCurrentTestState: vi.fn(() => TestFrameworkState.TEST),
                getCurrentHookState: vi.fn(() => HookState.PRE),
                getRef: vi.fn(() => 'test-ref-123')
            }

            vi.mocked(TestFramework.getState).mockReturnValue('test-uuid-123')

            const mockArgs = {
                test: { title: 'Test' } as Frameworks.Test,
                instance: mockInstance
            }

            await testHubModule.sendTestFrameworkEvent(mockArgs)

            expect(mockGrpcClient.testFrameworkEvent).toHaveBeenCalledWith({
                platformIndex: 0,
                testFrameworkName: 'mocha',
                testFrameworkVersion: '8.0.0',
                testFrameworkState: 'TEST',
                testHookState: 'PRE',
                startedAt: '2023-06-01T10:00:00Z',
                endedAt: '2023-06-01T10:01:00Z',
                uuid: 'test-uuid-123',
                eventJson: expect.any(Buffer),
                executionContext: {
                    hash: 'test-context-id',
                    threadId: 'thread-123',
                    processId: 'process-456'
                }
            })
        })

        it('should handle error in sendTestFrameworkEvent', async () => {
            const error = new Error('gRPC error')
            mockGrpcClient.testFrameworkEvent.mockRejectedValue(error)

            const mockInstance = {
                getContext: vi.fn(() => ({
                    getId: vi.fn(() => 'test-context-id'),
                    getThreadId: vi.fn(() => 'thread-123'),
                    getProcessId: vi.fn(() => 'process-456')
                })),
                getAllData: vi.fn(() => new Map()),
                getCurrentTestState: vi.fn(() => TestFrameworkState.TEST),
                getCurrentHookState: vi.fn(() => HookState.PRE)
            }

            const mockArgs = {
                test: { title: 'Test' } as Frameworks.Test,
                instance: mockInstance
            }

            await testHubModule.sendTestFrameworkEvent(mockArgs)

            expect(testHubModule.logger.error).toHaveBeenCalledWith(
                expect.stringContaining('Error in sendTestFrameworkEvent:')
            )
        })
    })

    describe('sendTestSessionEvent', () => {
        it('should send test session event successfully', async () => {
            const mockContext = {
                getId: vi.fn(() => 'test-context-id'),
                getThreadId: vi.fn(() => 'thread-123'),
                getProcessId: vi.fn(() => 'process-456')
            }

            const mockInstance = {
                getContext: vi.fn(() => mockContext),
                getCurrentTestState: vi.fn(() => TestFrameworkState.TEST),
                getCurrentHookState: vi.fn(() => HookState.PRE)
            }

            const mockAutomationInstance = {
                getRef: vi.fn(() => 'auto-ref-456'),
                frameworkName: 'webdriverio',
                frameworkVersion: '7.0.0'
            }

            vi.mocked(TestFramework.getState).mockImplementation((instance, key) => {
                if (key === TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME) {
                    return 'mocha'
                }
                if (key === TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION) {
                    return '8.0.0'
                }
                if (key === TestFrameworkConstants.KEY_TEST_UUID) {
                    return 'test-uuid-123'
                }
                return 'default-value'
            })

            vi.mocked(AutomationFramework.getState).mockImplementation((instance, key) => {
                if (key === AutomationFrameworkConstants.KEY_IS_BROWSERSTACK_HUB) {
                    return true
                }
                if (key === AutomationFrameworkConstants.KEY_FRAMEWORK_SESSION_ID) {
                    return 'session-id-123'
                }
                return 'default-value'
            })

            const mockDriver = {
                capabilities: { browserName: 'chrome', version: '91.0' }
            }
            vi.mocked(AutomationFramework.getDriver).mockReturnValue(mockDriver)

            const mockArgs = {
                instance: mockInstance,
                autoInstance: [mockAutomationInstance]
            }

            await testHubModule.sendTestSessionEvent(mockArgs)

            expect(mockGrpcClient.testSessionEvent).toHaveBeenCalledWith({
                testFrameworkName: 'mocha',
                testFrameworkVersion: '8.0.0',
                testFrameworkState: 'TEST',
                testHookState: 'PRE',
                testUuid: 'test-uuid-123',
                executionContext: {
                    threadId: 'thread-123',
                    processId: 'process-456'
                },
                automationSessions: [{
                    provider: 'browserstack',
                    ref: 'auto-ref-456',
                    hubUrl: 'https://hub.browserstack.com',
                    frameworkSessionId: 'session-id-123',
                    frameworkName: 'webdriverio',
                    frameworkVersion: '7.0.0'
                }],
                platformIndex: 0,
                capabilities: expect.any(Uint8Array)
            })
        })

        it('should handle gRPC error and throw', async () => {
            const error = new Error('gRPC connection failed')
            mockGrpcClient.testSessionEvent.mockRejectedValue(error)

            const mockInstance = {
                getContext: vi.fn(() => ({
                    getThreadId: vi.fn(() => 'thread-123'),
                    getProcessId: vi.fn(() => 'process-456')
                })),
                getCurrentTestState: vi.fn(() => TestFrameworkState.TEST),
                getCurrentHookState: vi.fn(() => HookState.PRE)
            }

            const mockArgs = {
                instance: mockInstance,
                autoInstance: []
            }

            await expect(testHubModule.sendTestSessionEvent(mockArgs)).rejects.toThrow(
                'Failed to send test session event:'
            )

            expect(testHubModule.logger.error).toHaveBeenCalledWith(
                expect.stringContaining('sendTestSessionEvent: Error sending grpc call:')
            )
        })
    })

    describe('sendLogCreatedEvent', () => {
        it('should send log created event successfully', async () => {
            const mockLogEntries = [
                {
                    [TestFrameworkConstants.KEY_HOOK_ID]: 'hook-123',
                    kind: 'console',
                    message: new Uint8Array([1, 2, 3]),
                    timestamp: '2023-06-01T10:00:00Z',
                    level: 'info'
                }
            ]

            const mockContext = {
                getId: vi.fn(() => 'test-context-id'),
                getThreadId: vi.fn(() => 'thread-123'),
                getProcessId: vi.fn(() => 'process-456')
            }

            const mockInstance = {
                getContext: vi.fn(() => mockContext),
                getAllData: vi.fn(() => new Map([
                    [TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME, 'mocha'],
                    [TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION, '8.0.0']
                ])),
                getCurrentTestState: vi.fn(() => TestFrameworkState.TEST),
                getCurrentHookState: vi.fn(() => HookState.PRE)
            }

            vi.mocked(TestFramework.getState).mockReturnValue('test-uuid-123')

            const mockArgs = {
                test: { title: 'Test' } as Frameworks.Test,
                instance: mockInstance,
                logEntries: mockLogEntries
            }

            await testHubModule.sendLogCreatedEvent(mockArgs)

            expect(mockGrpcClient.logCreatedEvent).toHaveBeenCalledWith({
                platformIndex: 0,
                logs: [
                    {
                        testFrameworkName: 'mocha',
                        testFrameworkVersion: '8.0.0',
                        testFrameworkState: 'TEST',
                        uuid: 'hook-123',
                        kind: 'console',
                        message: new Uint8Array([1, 2, 3]),
                        timestamp: '2023-06-01T10:00:00Z',
                        level: 'info'
                    }
                ],
                executionContext: {
                    hash: 'test-context-id',
                    threadId: 'thread-123',
                    processId: 'process-456'
                }
            })
        })

        it('should handle error in sendLogCreatedEvent', async () => {
            const error = new Error('Log creation failed')
            mockGrpcClient.logCreatedEvent.mockRejectedValue(error)

            const mockInstance = {
                getContext: vi.fn(() => ({
                    getId: vi.fn(() => 'test-context-id'),
                    getThreadId: vi.fn(() => 'thread-123'),
                    getProcessId: vi.fn(() => 'process-456')
                })),
                getAllData: vi.fn(() => new Map()),
                getCurrentTestState: vi.fn(() => TestFrameworkState.TEST),
                getCurrentHookState: vi.fn(() => HookState.PRE)
            }

            const mockArgs = {
                test: { title: 'Test' } as Frameworks.Test,
                instance: mockInstance,
                logEntries: []
            }

            await testHubModule.sendLogCreatedEvent(mockArgs)

            expect(testHubModule.logger.error).toHaveBeenCalledWith(
                expect.stringContaining('Error in sendLogCreatedEvent:')
            )
        })
    })

    describe('edge cases', () => {
        it('should handle missing WDIO_WORKER_ID environment variable', async () => {
            delete process.env.WDIO_WORKER_ID

            const mockInstance = {
                getContext: vi.fn(() => ({
                    getId: vi.fn(() => 'test-context-id'),
                    getThreadId: vi.fn(() => 'thread-123'),
                    getProcessId: vi.fn(() => 'process-456')
                })),
                getAllData: vi.fn(() => new Map()),
                getCurrentTestState: vi.fn(() => TestFrameworkState.TEST),
                getCurrentHookState: vi.fn(() => HookState.PRE)
            }

            vi.mocked(TestFramework.getState).mockReturnValue('test-uuid-123')

            const mockArgs = {
                test: { title: 'Test' } as Frameworks.Test,
                instance: mockInstance
            }

            await testHubModule.sendTestFrameworkEvent(mockArgs)

            expect(mockGrpcClient.testFrameworkEvent).toHaveBeenCalledWith(
                expect.objectContaining({ platformIndex: 0 })
            )
        })

        it('should handle empty log entries', async () => {
            const mockInstance = {
                getCurrentTestState: vi.fn(() => TestFrameworkState.LOG),
                getCurrentHookState: vi.fn(() => HookState.PRE)
            }

            vi.mocked(WdioMochaTestFramework.getLogEntries).mockReturnValue([])

            const sendLogCreatedEventSpy = vi.spyOn(testHubModule, 'sendLogCreatedEvent')

            const mockArgs = {
                instance: mockInstance,
                test: { title: 'Test' } as Frameworks.Test
            }

            await testHubModule.onAllTestEvents(mockArgs)

            expect(sendLogCreatedEventSpy).not.toHaveBeenCalled()
        })

        it('should handle empty automation instances array', async () => {
            const mockInstance = {
                getContext: vi.fn(() => ({
                    getThreadId: vi.fn(() => 'thread-123'),
                    getProcessId: vi.fn(() => 'process-456')
                })),
                getCurrentTestState: vi.fn(() => TestFrameworkState.TEST),
                getCurrentHookState: vi.fn(() => HookState.PRE)
            }

            vi.mocked(TestFramework.getState).mockImplementation((instance, key) => {
                if (key === TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME) {
                    return 'mocha'
                }
                if (key === TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION) {
                    return '8.0.0'
                }
                if (key === TestFrameworkConstants.KEY_TEST_UUID) {
                    return 'test-uuid-123'
                }
                return 'default-value'
            })

            const mockArgs = {
                instance: mockInstance,
                autoInstance: []
            }

            await testHubModule.sendTestSessionEvent(mockArgs)

            const call = mockGrpcClient.testSessionEvent.mock.calls[0][0]
            expect(call.automationSessions).toEqual([])
            expect(call.capabilities).toEqual(new Uint8Array())
        })
    })
})
describe('TestHubModule — WebDriver command logs', () => {
    const settle = () => new Promise(resolve => setImmediate(resolve))
    const title = { method: 'GET', endpoint: '/session/:sessionId/title', body: {} }
    const screenshot = { method: 'GET', endpoint: '/session/:sessionId/screenshot', body: {} }
    let module: TestHubModule
    let browser: EventEmitter & { sessionId: string }
    let framework: { trackEvent: Mock, capturesHttpCommandLogs: Mock }
    const logEntries = () => framework.trackEvent.mock.calls.map(([state, hook, args]) => {
        expect([state, hook]).toEqual([TestFrameworkState.LOG, HookState.POST])
        expect(args.commandLog).toBe(true)
        return args.logEntry
    })

    const register = (httpLogs: boolean) => {
        framework = { trackEvent: vi.fn().mockResolvedValue(undefined), capturesHttpCommandLogs: vi.fn().mockReturnValue(httpLogs) }
        module.setTestFramework(framework as unknown as TestFramework)
        module.onDriverCreated({ browser })
    }
    const run = async (command: Record<string, unknown>, result: unknown) => {
        browser.emit('command', { ...command })
        browser.emit('result', { ...command, result })
        await settle()
    }

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.BROWSERSTACK_OBSERVABILITY = 'true'
        process.env.BS_TESTOPS_ALLOW_SCREENSHOTS = 'true'
        module = new TestHubModule({})
        browser = Object.assign(new EventEmitter(), { sessionId: 's1' })
    })

    afterEach(() => {
        delete process.env.BROWSERSTACK_OBSERVABILITY
        delete process.env.BS_TESTOPS_ALLOW_SCREENSHOTS
    })

    it('observes driver creation', () => {
        expect(AutomationFramework.registerObserver).toHaveBeenCalledWith(expect.anything(), HookState.POST, expect.any(Function))
    })

    it('sends a paired HTTP log when the framework opts in, in the legacy message shape', async () => {
        register(true)
        await run(title, { value: 'StackDemo' })
        expect(logEntries()).toEqual([{ kind: 'HTTP', message: JSON.stringify({ path: title.endpoint, method: 'GET', body: {}, response: { value: 'StackDemo' } }), timestamp: expect.any(String) }])
    })

    it('sends no HTTP log, and listens for no command, when the framework does not opt in', async () => {
        register(false)
        await run(title, { value: 'StackDemo' })
        expect(browser.listenerCount('command')).toBe(0)
        expect(framework.trackEvent).not.toHaveBeenCalled()
    })

    it('sends a screenshot for every framework, then the HTTP log when opted in', async () => {
        register(false)
        await run(screenshot, { value: 'b64' })
        expect(logEntries()).toEqual([{ kind: 'TEST_SCREENSHOT', message: 'b64', timestamp: expect.any(String) }])

        browser = Object.assign(new EventEmitter(), { sessionId: 's1' })
        register(true)
        await run(screenshot, { value: 'b64' })
        expect(logEntries().map(e => e.kind)).toEqual(['TEST_SCREENSHOT', 'HTTP'])
    })

    it.each([undefined, 'false', ''])('sends no screenshot when allow_screenshots is %j', async (allow) => {
        if (allow === undefined) {
            delete process.env.BS_TESTOPS_ALLOW_SCREENSHOTS
        } else {
            process.env.BS_TESTOPS_ALLOW_SCREENSHOTS = allow
        }
        register(false)
        await run(screenshot, { value: 'b64' })
        expect(framework.trackEvent).not.toHaveBeenCalled()
    })

    it('pairs on the live session id, so a reload pairs its own commands and never an earlier session\'s', async () => {
        register(true)
        browser.emit('command', { ...title })
        browser.sessionId = 's2'
        browser.emit('result', { ...title, result: { value: 'old' } })
        await settle()
        expect(framework.trackEvent).not.toHaveBeenCalled()

        await run(title, { value: 'new' })
        expect(logEntries().map(e => JSON.parse(e.message).response.value)).toEqual(['new'])
    })

    it('pairs every result of concurrent same-key commands', async () => {
        register(true)
        browser.emit('command', { ...title })
        browser.emit('command', { ...title })
        browser.emit('result', { ...title, result: { value: 'a' } })
        browser.emit('result', { ...title, result: { value: 'b' } })
        await settle()
        expect(logEntries()).toHaveLength(2)
    })

    it('registers once per browser, so a reload never doubles the logs', async () => {
        register(true)
        module.onDriverCreated({ browser })
        await run(title, { value: 'StackDemo' })
        expect(browser.listenerCount('result')).toBe(1)
        expect(framework.trackEvent).toHaveBeenCalledTimes(1)
    })

    it('registers nothing, and later sends nothing, when no product reports events', async () => {
        delete process.env.BROWSERSTACK_OBSERVABILITY
        register(true)
        expect(browser.listenerCount('result')).toBe(0)

        process.env.BROWSERSTACK_OBSERVABILITY = 'true'
        browser = Object.assign(new EventEmitter(), { sessionId: 's1' })
        register(true)
        delete process.env.BROWSERSTACK_OBSERVABILITY
        await run(title, { value: 'StackDemo' })
        expect(framework.trackEvent).not.toHaveBeenCalled()
    })

    it('never throws out of a listener when the framework fails', async () => {
        register(true)
        framework.trackEvent.mockRejectedValue(new Error('track blew up'))
        await expect(run(screenshot, { value: 'b64' })).resolves.toBeUndefined()
        expect(BStackLogger.error).toHaveBeenCalledWith(expect.stringContaining('track blew up'))
    })

    it('logs nothing without a test framework', async () => {
        module.onDriverCreated({ browser })
        await expect(run(screenshot, { value: 'b64' })).resolves.toBeUndefined()
    })
})
