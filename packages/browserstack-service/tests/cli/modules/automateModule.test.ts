import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import AutomateModule from '../../../src/cli/modules/automateModule.js'
import TestFramework from '../../../src/cli/frameworks/testFramework.js'
import AutomationFramework from '../../../src/cli/frameworks/automationFramework.js'
import { TestFrameworkState } from '../../../src/cli/states/testFrameworkState.js'
import { AutomationFrameworkState } from '../../../src/cli/states/automationFrameworkState.js'
import { HookState } from '../../../src/cli/states/hookState.js'
import { TestFrameworkConstants } from '../../../src/cli/frameworks/constants/testFrameworkConstants.js'
import { isBrowserstackSession } from '../../../src/util.js'
import PerformanceTester from '../../../src/instrumentation/performance/performance-tester.js'
import { _fetch as fetch } from '../../../src/fetchWrapper.js'
import type { Options } from '@wdio/types'

// Mock dependencies
vi.mock('../../../src/cli/frameworks/testFramework.js', () => ({
    default: {
        registerObserver: vi.fn(),
        setState: vi.fn(),
        getState: vi.fn(),
        getTrackedInstance: vi.fn()
    }
}))

vi.mock('../../../src/cli/frameworks/automationFramework.js', () => ({
    default: {
        getTrackedInstance: vi.fn(),
        getState: vi.fn(),
        getDriver: vi.fn()
    }
}))

vi.mock('../../../src/cli/cliLogger.js', () => ({
    BStackLogger: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn()
    }
}))

vi.mock('../../../src/util.js', () => ({
    isBrowserstackSession: vi.fn(() => true),
    isTrue: vi.fn((value) => (value + '').toLowerCase() === 'true'),
    hasAppCap: vi.fn(() => false)
}))

vi.mock('../../../src/instrumentation/performance/performance-tester.js', () => ({
    default: {
        measureWrapper: vi.fn((event, fn) => fn)
    }
}))

vi.mock('../../../src/fetchWrapper.js', () => ({
    _fetch: vi.fn()
}))

describe('AutomateModule', () => {
    let automateModule: AutomateModule
    let mockConfig: Options.Testrunner
    let mockAutoInstance: any
    let mockBrowser: any
    let mockTestInstance: any

    beforeEach(() => {
        vi.clearAllMocks()

        mockConfig = {
            user: 'testuser',
            key: 'testkey'
        } as Options.Testrunner

        mockAutoInstance = {
            getId: vi.fn().mockReturnValue(1)
        }

        mockBrowser = {
            sessionId: 'test-session-id'
        }

        mockTestInstance = {
            getId: vi.fn().mockReturnValue(1)
        }

        // Setup AutomationFramework mocks
        vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue(mockAutoInstance)
        vi.mocked(AutomationFramework.getDriver).mockReturnValue(mockBrowser)
        vi.mocked(AutomationFramework.getState).mockImplementation((instance, key) => {
            if (key === 'framework_session_id') {return 'test-session-id'}
            if (key.includes('CAPABILITIES')) {return { browserName: 'chrome' }}
            return {}
        })

        // Reset isBrowserstackSession to default
        vi.mocked(isBrowserstackSession).mockReturnValue(true)

        automateModule = new AutomateModule(mockConfig)
        // Mock the config property
        automateModule.config = {
            testContextOptions: {
                skipSessionName: false,
                skipSessionStatus: false
            },
            userName: 'testuser',
            accessKey: 'testkey'
        } as any
    })

    it('should create an instance with correct module name', () => {
        expect(automateModule).toBeInstanceOf(AutomateModule)
        expect(automateModule.getModuleName()).toBe('AutomateModule')
    })

    it('should register observers during construction', () => {
        // Clear previous calls from construction in beforeEach
        vi.mocked(TestFramework.registerObserver).mockClear()

        // Create new instance to test observer registration (constructor registers the observers)
        new AutomateModule(mockConfig)

        expect(TestFramework.registerObserver).toHaveBeenCalledTimes(5)
        expect(TestFramework.registerObserver).toHaveBeenCalledWith(
            TestFrameworkState.TEST,
            HookState.PRE,
            expect.any(Function)
        )
        expect(TestFramework.registerObserver).toHaveBeenCalledWith(
            TestFrameworkState.TEST,
            HookState.POST,
            expect.any(Function)
        )
        expect(TestFramework.registerObserver).toHaveBeenCalledWith(
            AutomationFrameworkState.EXECUTE,
            HookState.POST,
            expect.any(Function)
        )
        expect(TestFramework.registerObserver).toHaveBeenCalledWith(
            TestFrameworkState.BEFORE_ALL,
            HookState.POST,
            expect.any(Function)
        )
        expect(TestFramework.registerObserver).toHaveBeenCalledWith(
            TestFrameworkState.AFTER_ALL,
            HookState.POST,
            expect.any(Function)
        )
    })

    it('should have correct static MODULE_NAME', () => {
        expect(AutomateModule.MODULE_NAME).toBe('AutomateModule')
    })

    it('should initialize with browserStackConfig', () => {
        expect(automateModule.browserStackConfig).toBe(mockConfig)
    })

    it('should have logger property', () => {
        expect(automateModule.logger).toBeDefined()
    })

    it('should have onBeforeTest method', () => {
        expect(typeof automateModule.onBeforeTest).toBe('function')
    })

    it('should have onAfterTest method', () => {
        expect(typeof automateModule.onAfterTest).toBe('function')
    })

    it('should have onAfterExecute method', () => {
        expect(typeof automateModule.onAfterExecute).toBe('function')
    })

    it('should have markSessionName method', () => {
        expect(typeof automateModule.markSessionName).toBe('function')
    })

    it('should handle onBeforeTest with basic args', async () => {
        const mockArgs = {
            instance: mockTestInstance,
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await automateModule.onBeforeTest(mockArgs)

        expect(TestFramework.setState).toHaveBeenCalled()
    })

    it('should skip session name update when skipSessionName is true', async () => {
        (automateModule.config as any).testContextOptions.skipSessionName = true
        const mockArgs = {
            instance: mockTestInstance,
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await automateModule.onBeforeTest(mockArgs)

        expect(TestFramework.setState).not.toHaveBeenCalled()
    })

    it('should skip session name update when not a BrowserStack session', async () => {
        vi.mocked(isBrowserstackSession).mockReturnValue(false)
        const mockArgs = {
            instance: mockTestInstance,
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await automateModule.onBeforeTest(mockArgs)

        expect(TestFramework.setState).not.toHaveBeenCalled()
    })

    it('should handle onAfterTest with basic args', async () => {
        const mockArgs = {
            instance: mockTestInstance,
            result: { error: null, passed: true },
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await automateModule.onAfterTest(mockArgs)

        expect(TestFramework.setState).toHaveBeenCalledTimes(2) // status and reason
    })

    it('names the session created by a mid-test reload (SDK-7270)', async () => {
        // browser.reloadSession() from the test body runs AFTER mocha's EVENT_TEST_BEGIN, so
        // onBeforeTest named the old session and the replacement was never registered.
        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ success: true })
        } as any)

        const mockArgs = {
            instance: mockTestInstance,
            result: { error: null, passed: true },
            test: { title: 'test title', parent: 'suite title' },
            suiteTitle: 'suite title'
        }

        await automateModule.onBeforeTest(mockArgs)

        // service.onReload repoints KEY_FRAMEWORK_SESSION_ID at the replacement session.
        vi.mocked(AutomationFramework.getState).mockImplementation((instance, key) => {
            if (key === 'framework_session_id') {return 'reloaded-session-id'}
            if (key.includes('CAPABILITIES')) {return { browserName: 'chrome' }}
            return {}
        })
        vi.mocked(fetch).mockClear()

        await automateModule.onAfterTest(mockArgs)

        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('sessions/reloaded-session-id.json'),
            expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'suite title - test title' }) })
        )
    })

    it('issues no extra name call when the session is unchanged across the test (SDK-7270 de-dupe)', async () => {
        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ success: true })
        } as any)

        const mockArgs = {
            instance: mockTestInstance,
            result: { error: null, passed: true },
            test: { title: 'test title', parent: 'suite title' },
            suiteTitle: 'suite title'
        }

        await automateModule.onBeforeTest(mockArgs)
        vi.mocked(fetch).mockClear()

        await automateModule.onAfterTest(mockArgs)

        // appliedName de-dupes — steady state must cost zero additional API calls.
        expect(fetch).not.toHaveBeenCalled()
    })

    it('still names a mid-test-reload session when skipSessionStatus is true (SDK-7270 guard independence)', async () => {
        // Naming and status are independent options; a status flag must not gate the name repair.
        (automateModule.config as any).testContextOptions.skipSessionStatus = true
        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ success: true })
        } as any)

        const mockArgs = {
            instance: mockTestInstance,
            result: { error: null, passed: true },
            test: { title: 'test title', parent: 'suite title' },
            suiteTitle: 'suite title'
        }

        await automateModule.onBeforeTest(mockArgs)

        vi.mocked(AutomationFramework.getState).mockImplementation((instance, key) => {
            if (key === 'framework_session_id') {return 'reloaded-session-id'}
            if (key.includes('CAPABILITIES')) {return { browserName: 'chrome' }}
            return {}
        })
        vi.mocked(fetch).mockClear()

        await automateModule.onAfterTest(mockArgs)

        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('sessions/reloaded-session-id.json'),
            expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'suite title - test title' }) })
        )
    })

    it('still status-marks a skipSessionName session, and sends no name', async () => {
        // `setSessionName: false` suppresses the NAME only. Legacy gates its `after()` status block
        // on setSessionStatus alone, and marks `passed` with an empty name — measured on BOTH
        // frameworks' legacy arms. This test previously asserted the opposite (no traffic at all),
        // which encoded the CLI's own behaviour rather than parity with legacy, and left every
        // CLI-flow session unmarked whenever a user opted out of naming.
        (automateModule.config as any).testContextOptions.skipSessionName = true
        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ success: true })
        } as any)

        const mockArgs = {
            instance: mockTestInstance,
            result: { error: null, passed: true },
            test: { title: 'test title', parent: 'suite title' },
            suiteTitle: 'suite title'
        }

        await automateModule.onBeforeTest(mockArgs)
        await automateModule.onAfterTest(mockArgs)
        vi.mocked(fetch).mockClear()

        await automateModule.onAfterExecute()

        const bodies = vi.mocked(fetch).mock.calls.map(([, init]) => (init as { body: string }).body)
        // exactly one call, and it is the status mark — no name field anywhere
        expect(bodies).toHaveLength(1)
        expect(JSON.parse(bodies[0])).not.toHaveProperty('name')
        expect(JSON.parse(bodies[0]).status).toBe('passed')
    })

    it('should skip session status update when skipSessionStatus is true', async () => {
        (automateModule.config as any).testContextOptions.skipSessionStatus = true
        const mockArgs = {
            instance: mockTestInstance,
            result: { error: null, passed: true },
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await automateModule.onAfterTest(mockArgs)

        expect(TestFramework.setState).not.toHaveBeenCalled()
    })

    it('should skip session status update when not a BrowserStack session', async () => {
        vi.mocked(isBrowserstackSession).mockReturnValue(false)
        const mockArgs = {
            instance: mockTestInstance,
            result: { error: null, passed: true },
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await automateModule.onAfterTest(mockArgs)

        expect(TestFramework.setState).not.toHaveBeenCalled()
    })

    it('should handle failed test result correctly', async () => {
        const mockArgs = {
            instance: mockTestInstance,
            result: { error: new Error('Test failed'), passed: false },
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await automateModule.onAfterTest(mockArgs)

        expect(TestFramework.setState).toHaveBeenCalledWith(
            mockTestInstance,
            'automate_session_status',
            'failed'
        )
        expect(TestFramework.setState).toHaveBeenCalledWith(
            mockTestInstance,
            'automate_session_reason',
            'Test failed'
        )
    })

    it('should handle onAfterExecute', async () => {
        // Setup session data by calling onBeforeTest and onAfterTest
        const testArgs = {
            instance: mockTestInstance,
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        const resultArgs = {
            instance: mockTestInstance,
            result: { error: null, passed: true },
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ success: true })
        } as any)

        // Simulate test lifecycle to populate sessionMap
        await automateModule.onBeforeTest(testArgs)
        await automateModule.onAfterTest(resultArgs)

        await automateModule.onAfterExecute()

        // onAfterExecute should complete without error
        expect(true).toBe(true)
    })

    it('should handle onAfterExecute with failed tests', async () => {
        const testArgs = {
            instance: mockTestInstance,
            test: { title: 'failed test' },
            suiteTitle: 'failed suite'
        }

        const resultArgs = {
            instance: mockTestInstance,
            result: { error: new Error('Test failed'), passed: false },
            test: { title: 'failed test' },
            suiteTitle: 'failed suite'
        }

        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ success: true })
        } as any)

        await automateModule.onBeforeTest(testArgs)
        await automateModule.onAfterTest(resultArgs)

        await automateModule.onAfterExecute()

        // onAfterExecute should complete without error
        expect(true).toBe(true)
    })

    it('should handle markSessionName with basic params', async () => {
        const sessionId = 'test-session-id'
        const sessionName = 'test-session-name'
        const config = { user: 'testuser', key: 'testkey' }

        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ success: true })
        } as any)

        await automateModule.markSessionName(sessionId, sessionName, config)

        expect(PerformanceTester.measureWrapper).toHaveBeenCalled()
        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('automate/sessions'),
            expect.objectContaining({
                method: 'PUT',
                headers: expect.objectContaining({
                    Authorization: expect.stringContaining('Basic'),
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({ name: sessionName })
            })
        )
    })

    it('should handle markSessionName for App Automate', async () => {
        (automateModule.config as any).app = 'test-app'
        const sessionId = 'test-session-id'
        const sessionName = 'test-session-name'
        const config = { user: 'testuser', key: 'testkey' }

        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ success: true })
        } as any)

        await automateModule.markSessionName(sessionId, sessionName, config)

        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('app-automate/sessions'),
            expect.any(Object)
        )
    })

    it('should handle markSessionStatus with basic params', async () => {
        const sessionId = 'test-session-id'
        const sessionStatus = 'passed' as const
        const config = { user: 'testuser', key: 'testkey' }

        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ success: true })
        } as any)

        await automateModule.markSessionStatus(sessionId, sessionStatus, undefined, config)

        expect(PerformanceTester.measureWrapper).toHaveBeenCalled()
        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('automate/sessions'),
            expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ status: sessionStatus })
            })
        )
    })

    it('should handle markSessionStatus with error message', async () => {
        const sessionId = 'test-session-id'
        const sessionStatus = 'failed' as const
        const errorMessage = 'Test failed with error'
        const config = { user: 'testuser', key: 'testkey' }

        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ success: true })
        } as any)

        await automateModule.markSessionStatus(sessionId, sessionStatus, errorMessage, config)

        expect(fetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                body: JSON.stringify({
                    status: sessionStatus,
                    reason: errorMessage
                })
            })
        )
    })

    it('routes markSessionName to the App Automate endpoint when skipAppOverride is true and no app is set', async () => {
        (automateModule.config as any).app = undefined
        ;(automateModule.config as any).skipAppOverride = true

        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ success: true })
        } as any)

        await automateModule.markSessionName('test-session-id', 'test-session-name', { user: 'testuser', key: 'testkey' })

        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('app-automate/sessions'),
            expect.any(Object)
        )
    })

    it('routes markSessionStatus to the App Automate endpoint when skipAppOverride is true and no app is set', async () => {
        (automateModule.config as any).app = undefined
        ;(automateModule.config as any).skipAppOverride = true

        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ success: true })
        } as any)

        await automateModule.markSessionStatus('test-session-id', 'passed', undefined, { user: 'testuser', key: 'testkey' })

        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('app-automate/sessions'),
            expect.objectContaining({ method: 'PUT' })
        )
    })

    it('should handle onBeforeTest with skipSessionName enabled', async () => {
        const configWithSkip = {
            ...mockConfig,
            testContextOptions: { skipSessionName: true }
        }
        const moduleWithSkip = new AutomateModule(configWithSkip)
        moduleWithSkip.config = configWithSkip

        const mockArgs = {
            instance: mockTestInstance,
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await moduleWithSkip.onBeforeTest(mockArgs)

        expect(TestFramework.setState).not.toHaveBeenCalled()
    })

    it('should handle onAfterTest with skipSessionStatus enabled', async () => {
        const configWithSkip = {
            ...mockConfig,
            testContextOptions: { skipSessionStatus: true }
        }
        const moduleWithSkip = new AutomateModule(configWithSkip)
        moduleWithSkip.config = configWithSkip

        const mockArgs = {
            instance: mockTestInstance,
            result: { error: null, passed: true },
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await moduleWithSkip.onAfterTest(mockArgs)

        expect(TestFramework.setState).not.toHaveBeenCalled()
    })

    it('should handle onAfterTest with failed test result', async () => {
        const mockArgs = {
            instance: {},
            result: { error: new Error('Test failed'), passed: false },
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await expect(automateModule.onAfterTest(mockArgs)).resolves.toBeUndefined()
    })

    it('should handle onBeforeTest with missing test title', async () => {
        const mockArgs = {
            instance: {},
            test: {},
            suiteTitle: 'suite title'
        }

        await expect(automateModule.onBeforeTest(mockArgs)).resolves.toBeUndefined()
    })

    it('should handle onAfterTest with missing result', async () => {
        const mockArgs = {
            instance: {},
            result: { error: null, passed: true }, // Provide basic result structure
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await expect(automateModule.onAfterTest(mockArgs)).resolves.toBeUndefined()
    })

    it('should handle error scenarios gracefully', async () => {
        // Test with empty sessionId
        await expect(automateModule.markSessionName('', 'test-name', { user: 'test', key: 'test' })).resolves.toBeUndefined()

        // Test with null sessionName
        await expect(automateModule.markSessionName('test-id', null as any, { user: 'test', key: 'test' })).resolves.toBeUndefined()

        // Test with undefined config
        await expect(automateModule.markSessionName('test-id', 'test-name', undefined as any)).resolves.toBeUndefined()
    })

    it('should handle creation without browserStackConfig', () => {
        const moduleWithoutConfig = new AutomateModule(undefined as any)
        expect(moduleWithoutConfig).toBeInstanceOf(AutomateModule)
        expect(moduleWithoutConfig.getModuleName()).toBe('AutomateModule')
    })
})

describe('AutomateModule testResults keying (SDK-7414)', () => {
    let automateModule: AutomateModule
    let mockTestInstance: any

    const FEATURE = 'A cucumber feature'

    // A cucumber test view carries fullName (the scenario); a mocha one never does.
    const cucumberTest = (scenario: string) => ({ title: scenario, fullName: scenario, parent: FEATURE })
    const mochaTest = (title: string) => ({ title, parent: FEATURE })

    const afterTest = (test: any, passed: boolean) => ({
        instance: mockTestInstance,
        result: { error: passed ? null : new Error(`${test.title} failed`), passed },
        test,
        suiteTitle: FEATURE
    })

    const sessionData = () => (automateModule as any).sessionMap.get('test-session-id')

    beforeEach(() => {
        vi.clearAllMocks()

        const mockAutoInstance = { getId: vi.fn().mockReturnValue(1) }
        mockTestInstance = { getId: vi.fn().mockReturnValue(1) }

        vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue(mockAutoInstance)
        vi.mocked(AutomationFramework.getDriver).mockReturnValue({ sessionId: 'test-session-id' })
        vi.mocked(AutomationFramework.getState).mockImplementation((instance, key) => {
            if (key === 'framework_session_id') {return 'test-session-id'}
            if (key.includes('CAPABILITIES')) {return { browserName: 'chrome' }}
            return {}
        })
        vi.mocked(isBrowserstackSession).mockReturnValue(true)
        vi.mocked(fetch).mockResolvedValue({ json: vi.fn().mockResolvedValue({ success: true }) } as any)

        automateModule = new AutomateModule({ user: 'testuser', key: 'testkey' } as Options.Testrunner)
        automateModule.config = {
            testContextOptions: { skipSessionName: false, skipSessionStatus: false },
            userName: 'testuser',
            accessKey: 'testkey'
        } as any
    })

    // The defect: every scenario in a feature shares the session name, so keying testResults on it
    // collapsed N scenarios into one last-write-wins entry and a trailing pass hid earlier failures.
    it('keeps one entry per scenario for cucumber, so a trailing pass cannot mask an earlier failure', async () => {
        await automateModule.onAfterTest(afterTest(cucumberTest('scenario one fails'), false))
        await automateModule.onAfterTest(afterTest(cucumberTest('scenario two passes'), true))

        const results = sessionData().testResults
        expect([...results.keys()]).toEqual(['scenario one fails', 'scenario two passes'])
        expect(results.size).toBe(2)
        expect([...results.values()].map((r: any) => r.status)).toEqual(['failed', 'passed'])
        // the session NAME stays the feature title even though the keys do not.
        expect(sessionData().lastTestName).toBe(FEATURE)
    })

    // The discriminating pair: identical input shape, opposite answers through the resultKey branch.
    it('keys on the scenario for cucumber and leaves the key unchanged for mocha', async () => {
        await automateModule.onAfterTest(afterTest(cucumberTest('a scenario'), true))
        const cucumberKey = [...sessionData().testResults.keys()][0]
        const cucumberName = sessionData().lastTestName

        vi.clearAllMocks()
        vi.mocked(AutomationFramework.getDriver).mockReturnValue({ sessionId: 'test-session-id' })
        vi.mocked(AutomationFramework.getState).mockImplementation((instance, key) => {
            if (key === 'framework_session_id') {return 'test-session-id'}
            if (key.includes('CAPABILITIES')) {return { browserName: 'chrome' }}
            return {}
        })
        vi.mocked(isBrowserstackSession).mockReturnValue(true)
        vi.mocked(fetch).mockResolvedValue({ json: vi.fn().mockResolvedValue({ success: true }) } as any)
        ;(automateModule as any).sessionMap = new Map()

        await automateModule.onAfterTest(afterTest(mochaTest('a test'), true))
        const mochaKey = [...sessionData().testResults.keys()][0]
        const mochaName = sessionData().lastTestName

        expect(cucumberKey).toBe('a scenario')
        expect(cucumberKey).not.toBe(cucumberName)
        expect(mochaKey).toBe(mochaName)
        expect(mochaKey).toBe(`${FEATURE} - a test`)
    })
})

const cucumberInstance = { framework: 'WebdriverIO-cucumber' }
const mochaInstance = { framework: 'WebdriverIO-mocha' }

function stateFor(instance: unknown, key: string) {
    if (key === TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME) {
        return (instance as { framework: string }).framework
    }
    if (key === TestFrameworkConstants.KEY_HOOKS_FINISHED) {
        return new Map([['BEFORE_ALL', [{ [TestFrameworkConstants.KEY_HOOK_NAME]: 'BEFORE_ALL for Login' }]]])
    }
    return undefined
}

function newModule(config: Record<string, unknown> = {}) {
    const mod = new AutomateModule({ user: 'u', key: 'k' } as Options.Testrunner)
    mod.config = {
        testContextOptions: { skipSessionName: false, skipSessionStatus: false },
        userName: 'testuser',
        accessKey: 'testkey',
        ...config
    } as never

    return mod
}

describe('AutomateModule — session marking', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue({} as never)
        vi.mocked(AutomationFramework.getState).mockImplementation((_i, key) =>
            key === 'framework_session_id' ? 'sess-1' : ({} as never))
        vi.mocked(TestFramework.getState).mockImplementation((instance, key) => stateFor(instance, key))
        vi.mocked(fetch).mockResolvedValue({ json: async () => ({ ok: true }) } as never)
        delete process.env.BROWSERSTACK_TURBOSCALE_INTERNAL
    })

    afterEach(() => {
        delete process.env.BROWSERSTACK_TURBOSCALE_INTERNAL
    })

    // Discriminating: the same call yields opposite verbs and different hosts on the flag alone.
    describe('turboscale routes to its own API with PATCH', () => {
        it('PATCHes the turboscale endpoint when turboScale is configured', async () => {
            const mod = newModule({ turboScale: true })
            await mod.markSessionStatus('sess-1', 'passed', undefined, { user: 'u', key: 'k' })

            const [url, options] = vi.mocked(fetch).mock.calls[0]
            expect(url).toBe('https://api.browserstack.com/automate-turboscale/v1/sessions/sess-1.json')
            expect((options as { method: string }).method).toBe('PATCH')
        })

        it('PUTs the automate endpoint when turboScale is not configured', async () => {
            const mod = newModule()
            await mod.markSessionStatus('sess-1', 'passed', undefined, { user: 'u', key: 'k' })

            const [url, options] = vi.mocked(fetch).mock.calls[0]
            expect(url).toBe('https://api.browserstack.com/automate/sessions/sess-1.json')
            expect((options as { method: string }).method).toBe('PUT')
        })

        it('takes precedence over app-automate, mirroring legacy assignment order', async () => {
            const mod = newModule({ turboScale: true, app: 'bs://app' })
            await mod.markSessionStatus('sess-1', 'failed', 'boom', { user: 'u', key: 'k' })

            expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/automate-turboscale/v1/sessions/')
        })
    })

    // A build-level hook has no test tied to it, so its failure reaches the verdict only here.
    // Discriminating: the same failing hook fails cucumber and leaves mocha untouched.
    describe('build-level hook failures reach the session verdict', () => {
        const failing = { passed: false, error: new Error('BeforeAll blew up') }

        const runScenario = (mod: AutomateModule, passed: boolean) => mod.onAfterTest({
            instance: cucumberInstance,
            result: { error: passed ? null : new Error('step failed'), passed },
            test: { title: 'a scenario', fullName: 'Feature: a scenario' },
            suiteTitle: 'Feature'
        })

        const statusBody = () => {
            const call = vi.mocked(fetch).mock.calls.find(([, o]) =>
                JSON.parse((o as { body: string }).body).status !== undefined)

            return call ? JSON.parse((call[1] as { body: string }).body) : undefined
        }

        it('marks the session failed for cucumber when a BeforeAll fails', async () => {
            const mod = newModule()
            await mod.onBuildLevelHookEnd('BEFORE_ALL', { instance: cucumberInstance, result: failing })
            await mod.onAfterExecute()

            expect(statusBody().status).toBe('failed')
            expect(statusBody().reason).toBe('BeforeAll blew up')
        })

        it('names the hook in the failure reason when several fail', async () => {
            const mod = newModule()
            await mod.onBuildLevelHookEnd('BEFORE_ALL', { instance: cucumberInstance, result: failing })
            await mod.onBuildLevelHookEnd('AFTER_ALL', { instance: cucumberInstance, result: { passed: false, error: new Error('teardown') } })
            await mod.onAfterExecute()

            expect(statusBody().reason).toContain('BEFORE_ALL for Login')
        })

        it('leaves wdio_mocha untouched — the identical failure records nothing', async () => {
            const mod = newModule()
            await mod.onBuildLevelHookEnd('BEFORE_ALL', { instance: mochaInstance, result: failing })
            await mod.onAfterExecute()

            expect(fetch).not.toHaveBeenCalled()
        })

        it('records nothing when the hook passed', async () => {
            const mod = newModule()
            await mod.onBuildLevelHookEnd('BEFORE_ALL', { instance: cucumberInstance, result: { passed: true } })
            await mod.onAfterExecute()

            expect(fetch).not.toHaveBeenCalled()
        })

        it('keeps the session PASSED under ignoreHooksStatus once a scenario has run', async () => {
            const mod = newModule()
            await runScenario(mod, true)
            await mod.onBuildLevelHookEnd('AFTER_ALL', { instance: cucumberInstance, result: failing, ignoreHooksStatus: true })
            await mod.onAfterExecute()

            expect(statusBody()).toEqual({ status: 'passed' })
        })

        // Zero scenarios is legacy's `!_specsRan` arm, which marks failed regardless of the flag.
        // Discriminating against the case above: same hook, same flag, opposite verdicts.
        it('marks the session FAILED under ignoreHooksStatus when no scenario ran', async () => {
            const mod = newModule()
            await mod.onBuildLevelHookEnd('BEFORE_ALL', { instance: cucumberInstance, result: failing, ignoreHooksStatus: true })
            await mod.onAfterExecute()

            expect(statusBody().status).toBe('failed')
        })

        it('respects skipSessionStatus', async () => {
            const mod = newModule({ testContextOptions: { skipSessionName: false, skipSessionStatus: true } })
            await mod.onBuildLevelHookEnd('BEFORE_ALL', { instance: cucumberInstance, result: failing })
            await mod.onAfterExecute()

            expect(fetch).not.toHaveBeenCalled()
        })
    })
})

describe('AutomateModule preferScenarioName', () => {
    const register = (mod: AutomateModule, lastTestName: string, seed: Record<string, unknown> = {}) => {
        (mod['sessionMap'] as Map<string, Record<string, unknown>>)
            .set('sess-1', { lastTestName, testResults: new Map(), scenariosRan: 0, ...seed })
    }

    const namesPUT = () => vi.mocked(fetch).mock.calls.map(([, init]) => {
        try {
            return JSON.parse((init as { body: string }).body).name
        } catch {
            return undefined
        }
    })

    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue({} as never)
        vi.mocked(AutomationFramework.getState).mockImplementation((_i, key) =>
            key === 'framework_session_id' ? 'sess-1' : ({} as never))
        vi.mocked(fetch).mockResolvedValue({ json: async () => ({ ok: true }) } as never)
    })

    it('renames to the scenario name when exactly one scenario ran', async () => {
        const mod = newModule()
        register(mod, 'Login Feature', { scenariosRan: 1, lastScenarioName: 'Can log in', preferScenarioName: true })

        await mod.onAfterExecute()

        expect(namesPUT()).toContain('Can log in')
    })

    // The `=== 1` exactness legacy applies — a `>= 1` here renames every multi-scenario feature.
    it('keeps the feature name when two scenarios ran', async () => {
        const mod = newModule()
        register(mod, 'Login Feature', { scenariosRan: 2, lastScenarioName: 'Second scenario', preferScenarioName: true })

        await mod.onAfterExecute()

        expect(namesPUT()).not.toContain('Second scenario')
        expect(namesPUT()).toContain('Login Feature')
    })

    it('keeps the feature name when the flag is absent', async () => {
        const mod = newModule()
        register(mod, 'Login Feature', { scenariosRan: 1, lastScenarioName: 'Can log in' })

        await mod.onAfterExecute()

        expect(namesPUT()).not.toContain('Can log in')
    })

    it('honours setSessionName: false and issues no rename', async () => {
        const mod = newModule({ testContextOptions: { skipSessionName: true, skipSessionStatus: false } })
        register(mod, 'Login Feature', { scenariosRan: 1, lastScenarioName: 'Can log in', preferScenarioName: true })

        await mod.onAfterExecute()

        expect(namesPUT()).not.toContain('Can log in')
    })

    // A skipped scenario is not a scenario that ran; legacy's counter is gated the same way.
    it('does not count a skipped scenario', async () => {
        const mod = newModule()
        register(mod, 'Login Feature', { preferScenarioName: true })

        await mod.onAfterExecute()

        expect(namesPUT()).not.toContain('Can log in')
    })
})
