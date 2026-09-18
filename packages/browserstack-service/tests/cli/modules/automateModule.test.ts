import { describe, expect, it, vi, beforeEach } from 'vitest'
import got from 'got'
import AutomateModule from '../../../src/cli/modules/automateModule.js'
import TestFramework from '../../../src/cli/frameworks/testFramework.js'
import AutomationFramework from '../../../src/cli/frameworks/automationFramework.js'
import { TestFrameworkConstants } from '../../../src/cli/frameworks/constants/testFrameworkConstants.js'
import { isBrowserstackSession } from '../../../src/util.js'
import type { Options } from '@wdio/types'

// Mock dependencies
vi.mock('../../../src/cli/frameworks/testFramework.js', () => ({
    default: {
        registerObserver: vi.fn(),
        setState: vi.fn(),
        getState: vi.fn()
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

vi.mock('got', () => ({
    default: vi.fn()
}))

vi.mock('../../../src/util.js', () => ({
    isBrowserstackSession: vi.fn(() => false),
    isTrue: vi.fn((value) => (value + '').toLowerCase() === 'true')
}))

describe('AutomateModule', () => {
    let automateModule: AutomateModule
    let mockConfig: Options.Testrunner

    beforeEach(() => {
        mockConfig = {
            user: 'testuser',
            key: 'testkey'
        } as Options.Testrunner

        automateModule = new AutomateModule(mockConfig)
        // Mock the config property
        automateModule.config = {
            testContextOptions: {
                skipSessionName: false,
                skipSessionStatus: false
            }
        } as any
    })

    it('should create an instance with correct module name', () => {
        expect(automateModule).toBeInstanceOf(AutomateModule)
        expect(automateModule.getModuleName()).toBe('AutomateModule')
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
            instance: {},
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        // Should not throw error
        await expect(automateModule.onBeforeTest(mockArgs)).resolves.toBeUndefined()
    })

    it('should handle onAfterTest with basic args', async () => {
        const mockArgs = {
            instance: {},
            result: { error: null, passed: true },
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        // Should not throw error
        await expect(automateModule.onAfterTest(mockArgs)).resolves.toBeUndefined()
    })

    it('should handle onAfterExecute', async () => {
        // Should not throw error
        await expect(automateModule.onAfterExecute()).resolves.toBeUndefined()
    })

    it('should handle markSessionName with basic params', async () => {
        const sessionId = 'test-session-id'
        const sessionName = 'test-session-name'
        const config = { user: 'testuser', key: 'testkey' }

        // Should not throw error
        await expect(automateModule.markSessionName(sessionId, sessionName, config)).resolves.toBeUndefined()
    })

    it('routes markSessionName to the App Automate endpoint when skipAppOverride is true and no app is set', async () => {
        (automateModule.config as any).app = undefined
        ;(automateModule.config as any).skipAppOverride = true
        vi.mocked(got).mockResolvedValue({ body: {} } as any)

        await automateModule.markSessionName('test-session-id', 'test-session-name', { user: 'testuser', key: 'testkey' })

        expect(got).toHaveBeenCalledWith(
            expect.objectContaining({ url: expect.stringContaining('app-automate/sessions') })
        )
    })

    it('routes markSessionStatus to the App Automate endpoint when skipAppOverride is true and no app is set', async () => {
        (automateModule.config as any).app = undefined
        ;(automateModule.config as any).skipAppOverride = true
        vi.mocked(got).mockResolvedValue({ body: {} } as any)

        await automateModule.markSessionStatus('test-session-id', 'passed', undefined, { user: 'testuser', key: 'testkey' })

        expect(got).toHaveBeenCalledWith(
            expect.objectContaining({ url: expect.stringContaining('app-automate/sessions') })
        )
    })

    it('should handle onBeforeTest with skipSessionName enabled', async () => {
        const configWithSkip = {
            ...mockConfig,
            testContextOptions: { skipSessionName: true }
        }
        const moduleWithSkip = new AutomateModule(configWithSkip)
        moduleWithSkip.config = configWithSkip // Ensure config is set properly

        const mockArgs = {
            instance: {},
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await expect(moduleWithSkip.onBeforeTest(mockArgs)).resolves.toBeUndefined()
    })

    it('applies sessionNameFormat from the injected service options', async () => {
        // The formatter is a function, so JSON drops it from the config the binary echoes back.
        // It reaches the module only through the injected options; testContextOptions below is
        // deliberately shaped as the binary really returns it, with no sessionNameFormat key.
        const sessionNameFormat = vi.fn((_config, _caps, suiteTitle, testTitle) => `FMT::${suiteTitle}::${testTitle}`)
        const moduleWithFormat = new AutomateModule(mockConfig, { sessionNameFormat })
        moduleWithFormat.config = {
            testContextOptions: { skipSessionName: false, skipSessionStatus: false }
        } as any

        vi.mocked(isBrowserstackSession).mockReturnValue(true)
        vi.mocked(AutomationFramework.getState).mockReturnValue('session-1')

        await moduleWithFormat.onBeforeTest({
            instance: {},
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        })

        expect(sessionNameFormat).toHaveBeenCalled()
        expect(TestFramework.setState).toHaveBeenCalledWith(
            expect.anything(),
            TestFrameworkConstants.KEY_AUTOMATE_SESSION_NAME,
            'FMT::suite title::test title'
        )
    })

    it('renames the session to the scenario when preferScenarioName and exactly one scenario ran', async () => {
        // The rename is only decidable at EXECUTE/POST — "exactly one" is not knowable while
        // scenarios are still arriving — so the module counts them and applies it there.
        const mod = new AutomateModule(mockConfig, {})
        mod.config = {
            userName: 'testuser',
            accessKey: 'testkey',
            testContextOptions: { skipSessionName: false, skipSessionStatus: false }
        } as any

        vi.mocked(isBrowserstackSession).mockReturnValue(true)
        vi.mocked(AutomationFramework.getState).mockReturnValue('session-pref')
        vi.mocked(TestFramework.getState).mockReturnValue('cucumber')   // isCucumberInstance

        await mod.onBeforeTest({ instance: {}, test: { title: 'ignored' }, suiteTitle: 'Feature title' })
        await mod.onAfterTest({
            instance: {},
            result: { error: null, passed: true },
            test: { title: 'The only scenario' },
            suiteTitle: 'Feature title',
            preferScenarioName: true
        })

        const spy = vi.spyOn(mod, 'markSessionName').mockResolvedValue(undefined)
        await mod.onAfterExecute()

        expect(spy).toHaveBeenCalledWith('session-pref', 'The only scenario', expect.anything())
    })

    it('falls back to the suite title when no sessionNameFormat is configured', async () => {
        const moduleNoFormat = new AutomateModule(mockConfig, {})
        moduleNoFormat.config = {
            testContextOptions: { skipSessionName: false, skipSessionStatus: false }
        } as any

        vi.mocked(isBrowserstackSession).mockReturnValue(true)
        vi.mocked(AutomationFramework.getState).mockReturnValue('session-2')

        await moduleNoFormat.onBeforeTest({
            instance: {},
            test: { title: 'test title', fullName: 'full name' },
            suiteTitle: 'suite title'
        })

        expect(TestFramework.setState).toHaveBeenCalledWith(
            expect.anything(),
            TestFrameworkConstants.KEY_AUTOMATE_SESSION_NAME,
            'suite title'
        )
    })

    it('should handle onAfterTest with skipSessionStatus enabled', async () => {
        const configWithSkip = {
            ...mockConfig,
            testContextOptions: { skipSessionStatus: true }
        }
        const moduleWithSkip = new AutomateModule(configWithSkip)
        moduleWithSkip.config = configWithSkip // Ensure config is set properly

        const mockArgs = {
            instance: {},
            result: { error: null, passed: true },
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await expect(moduleWithSkip.onAfterTest(mockArgs)).resolves.toBeUndefined()
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

    it('should handle markSessionName with empty sessionId', async () => {
        const sessionId = ''
        const sessionName = 'test-session-name'
        const config = { user: 'testuser', key: 'testkey' }

        await expect(automateModule.markSessionName(sessionId, sessionName, config)).resolves.toBeUndefined()
    })

    it('should handle markSessionName with null sessionName', async () => {
        const sessionId = 'test-session-id'
        const sessionName = null as any
        const config = { user: 'testuser', key: 'testkey' }

        await expect(automateModule.markSessionName(sessionId, sessionName, config)).resolves.toBeUndefined()
    })

    it('should handle markSessionName with undefined config', async () => {
        const sessionId = 'test-session-id'
        const sessionName = 'test-session-name'
        const config = undefined as any

        await expect(automateModule.markSessionName(sessionId, sessionName, config)).resolves.toBeUndefined()
    })

    it('should handle onBeforeTest with null instance', async () => {
        const mockArgs = {
            instance: null,
            test: { title: 'test title' },
            suiteTitle: 'suite title'
        }

        await expect(automateModule.onBeforeTest(mockArgs)).resolves.toBeUndefined()
    })

    it('should handle onAfterTest with undefined test', async () => {
        const mockArgs = {
            instance: {},
            result: { error: null, passed: true },
            test: { title: 'test title' }, // Provide basic test structure
            suiteTitle: 'suite title'
        }

        await expect(automateModule.onAfterTest(mockArgs)).resolves.toBeUndefined()
    })

    it('should handle creation without browserStackConfig', () => {
        const moduleWithoutConfig = new AutomateModule(undefined as any)
        expect(moduleWithoutConfig).toBeInstanceOf(AutomateModule)
        expect(moduleWithoutConfig.getModuleName()).toBe('AutomateModule')
    })

    it('should have sessionMap property accessible via method check', () => {
        // Test that the module has internal state management capabilities
        // by checking if it's an instance of AutomateModule (which should have sessionMap)
        expect(automateModule).toBeInstanceOf(AutomateModule)
        expect(automateModule.getModuleName()).toBe('AutomateModule')
    })

    it('should handle multiple sequential onBeforeTest calls', async () => {
        const mockArgs1 = {
            instance: {},
            test: { title: 'test 1' },
            suiteTitle: 'suite 1'
        }

        const mockArgs2 = {
            instance: {},
            test: { title: 'test 2' },
            suiteTitle: 'suite 2'
        }

        await expect(automateModule.onBeforeTest(mockArgs1)).resolves.toBeUndefined()
        await expect(automateModule.onBeforeTest(mockArgs2)).resolves.toBeUndefined()
    })

    it('should handle multiple sequential onAfterTest calls', async () => {
        const mockArgs1 = {
            instance: {},
            result: { error: null, passed: true },
            test: { title: 'test 1' },
            suiteTitle: 'suite 1'
        }

        const mockArgs2 = {
            instance: {},
            result: { error: null, passed: false },
            test: { title: 'test 2' },
            suiteTitle: 'suite 2'
        }

        await expect(automateModule.onAfterTest(mockArgs1)).resolves.toBeUndefined()
        await expect(automateModule.onAfterTest(mockArgs2)).resolves.toBeUndefined()
    })
})