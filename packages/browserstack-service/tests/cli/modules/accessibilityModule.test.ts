import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../src/cli/frameworks/testFramework.js', () => ({
    default: class MockTestFramework {
        static registerObserver = vi.fn()
        static getTrackedInstance = vi.fn()
        static getState = vi.fn()
        static setState = vi.fn()
    }
}))

vi.mock('../../../src/cli/frameworks/automationFramework.js', () => ({
    default: class MockAutomationFramework {
        static registerObserver = vi.fn()
        static getTrackedInstance = vi.fn()
        static getDriver = vi.fn()
        static getState = vi.fn()
    }
}))

vi.mock('../../../src/scripts/accessibility-scripts.js', () => ({
    default: {
        commandsToWrap: [],
        performScan: 'mock-perform-scan-script',
        getResults: 'mock-get-results-script',
        getResultsSummary: 'mock-get-results-summary-script',
        saveTestResults: 'mock-save-test-results-script'
    }
}))

vi.mock('../../../src/util.js', () => ({
    validateCapsWithA11y: vi.fn().mockReturnValue(true),
    validateCapsWithAppA11y: vi.fn().mockReturnValue(true),
    shouldScanTestForAccessibility: vi.fn().mockReturnValue(true),
    getAppA11yResults: vi.fn().mockResolvedValue([]),
    getAppA11yResultsSummary: vi.fn().mockResolvedValue({}),
    _getParamsForAppAccessibility: vi.fn().mockReturnValue('{}'),
    formatString: vi.fn().mockReturnValue('formatted-script'),
    o11yClassErrorHandler: vi.fn().mockImplementation((cls) => cls),
    isBrowserstackSession: vi.fn().mockReturnValue(true)
}))

// hoisted: vi.mock factories are lifted above module scope, and `getInstance` is a plain
// function rather than a spy so the suite-wide clearAllMocks/resetAllMocks cannot strip its
// return value out from under the module constructor.
const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }))
vi.mock('../../../src/cli/index.js', () => ({
    BrowserstackCLI: {
        getInstance: () => ({
            options: {},
            getTestFramework: () => ({ trackEvent: mockTrackEvent })
        })
    }
}))

const { mockGetHookFailure } = vi.hoisted(() => ({ mockGetHookFailure: vi.fn() }))
vi.mock('../../../src/hookInstrumentation.js', () => ({ getPreTestWindowFailure: mockGetHookFailure }))

vi.mock('../../../src/cli/grpcClient.js', () => ({
    GrpcClient: {
        getInstance: vi.fn().mockReturnValue({
            fetchDriverExecuteParamsEvent: vi.fn().mockResolvedValue({
                success: true,
                accessibilityExecuteParams: Buffer.from('{}').toString('base64')
            })
        })
    }
}))

import AccessibilityModule from '../../../src/cli/modules/accessibilityModule.js'
import { validateCapsWithA11y, validateCapsWithAppA11y, _getParamsForAppAccessibility, shouldScanTestForAccessibility } from '../../../src/util.js'
import accessibilityScripts from '../../../src/scripts/accessibility-scripts.js'
import TestFramework from '../../../src/cli/frameworks/testFramework.js'
import AutomationFramework from '../../../src/cli/frameworks/automationFramework.js'
import { AutomationFrameworkState } from '../../../src/cli/states/automationFrameworkState.js'
import { HookState } from '../../../src/cli/states/hookState.js'
import { TestFrameworkState } from '../../../src/cli/states/testFrameworkState.js'

describe('AccessibilityModule', () => {
    let accessibilityModule: AccessibilityModule
    let mockAccessibilityConfig: any
    let mockBrowser: any
    let mockAutoInstance: any
    let mockTestInstance: any

    beforeEach(() => {
        vi.clearAllMocks()

        mockAccessibilityConfig = {
            isAppAccessibility: false,
            success: true,
            errors: []
        }

        mockBrowser = {
            executeAsync: vi.fn().mockResolvedValue([]),
            execute: vi.fn().mockResolvedValue({}),
            overwriteCommand: vi.fn()
        }

        mockAutoInstance = {
            getId: vi.fn().mockReturnValue(1)
        }

        mockTestInstance = {
            getContext: vi.fn().mockReturnValue({ getId: vi.fn().mockReturnValue(1) }),
            getData: vi.fn(),
            setData: vi.fn()
        }

        vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue(mockAutoInstance)
        vi.mocked(AutomationFramework.getDriver).mockReturnValue(mockBrowser)
        vi.mocked(AutomationFramework.getState).mockImplementation((instance, key) => {
            if (key.includes('SESSION_ID')) {
                return 12345
            }
            return {}
        })

        vi.mocked(TestFramework.getTrackedInstance).mockReturnValue(mockTestInstance)

        accessibilityModule = new AccessibilityModule(mockAccessibilityConfig, false)

        accessibilityModule.config = { accessibilityOptions: {} }
    })

    afterEach(() => {
        vi.resetAllMocks()
        mockTrackEvent.mockReset()
    })

    describe('constructor', () => {
        it('should register observers for both automation and test frameworks', () => {
            expect(AutomationFramework.registerObserver).toHaveBeenCalledWith(
                AutomationFrameworkState.CREATE,
                HookState.POST,
                expect.any(Function)
            )
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
        })

        it('should initialize with correct properties', () => {
            expect(accessibilityModule.name).toBe('AccessibilityModule')
            expect(accessibilityModule.accessibility).toBe(true)
            expect(accessibilityModule.isAppAccessibility).toBe(false)
            expect(accessibilityModule.isNonBstackA11y).toBe(false)
            expect(accessibilityModule.accessibilityConfig).toBe(mockAccessibilityConfig)
            expect(accessibilityModule.accessibilityMap).toBeInstanceOf(Map)
            expect(accessibilityModule.LOG_DISABLED_SHOWN).toBeInstanceOf(Map)
        })

        it('should set isAppAccessibility from config', () => {
            const appConfig = { isAppAccessibility: true, success: true, errors: [] }
            const module = new AccessibilityModule(appConfig, false)
            expect(module.isAppAccessibility).toBe(true)
            expect(module.isNonBstackA11y).toBe(false)
        })

        it('should set isNonBstackA11y from constructor parameter', () => {
            const config = { isAppAccessibility: false, success: true, errors: [] }
            const module = new AccessibilityModule(config, true)
            expect(module.isNonBstackA11y).toBe(true)
        })
    })

    describe('getModuleName', () => {
        it('should return the correct module name', () => {
            expect(accessibilityModule.getModuleName()).toBe('BaseModule') // AccessibilityModule doesn't override getModuleName
            expect(AccessibilityModule.MODULE_NAME).toBe('AccessibilityModule')
        })
    })

    describe('onBeforeExecute', () => {
        it('should patch browser methods when automation instance exists', async () => {
            vi.mocked(AutomationFramework.getState).mockImplementation((instance, key) => {
                if (key.includes('CAPABILITIES')) {
                    return { browserName: 'chrome' }
                }
                if (key.includes('INPUT_CAPABILITIES')) {
                    return {}
                }
                return 12345
            })

            await accessibilityModule.onBeforeExecute()

            // Verify that onBeforeExecute completes without error
            // The actual browser patching happens on the object returned by AutomationFramework.getDriver
            expect(vi.mocked(AutomationFramework.getDriver)).toHaveBeenCalled()
        })

        it('should return early when no automation instance found', async () => {
            vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue(null)

            await accessibilityModule.onBeforeExecute()

            expect(mockBrowser.getAccessibilityResultsSummary).toBeUndefined()
            expect(mockBrowser.getAccessibilityResults).toBeUndefined()
            expect(mockBrowser.performScan).toBeUndefined()
        })

        it('should return early when no browser instance found', async () => {
            vi.mocked(AutomationFramework.getDriver).mockReturnValue(null)

            await accessibilityModule.onBeforeExecute()

            expect(mockBrowser.getAccessibilityResultsSummary).toBeUndefined()
        })
    })

    describe('pre-test scan gate and its hook run', () => {
        const withA11yOn = () => {
            vi.mocked(validateCapsWithA11y).mockReturnValue(true)
            vi.mocked(AutomationFramework.getState).mockImplementation((instance, key) => {
                if (key.includes('CAPABILITIES')) {
                    return { browserName: 'chrome' }
                }
                return 'live-session'
            })
        }

        it('opens the scan gate at driver creation, so config-level before() commands scan', async () => {
            // WDIO's config-level before()/beforeSession() are not test-framework hooks, so
            // neither onHookStart nor onBeforeTest has run when they fire their commands.
            withA11yOn()

            await accessibilityModule.onBeforeExecute()

            expect(accessibilityModule.accessibilityMap.get('live-session')).toBe(true)
        })

        it('leaves the gate closed when autoScanning is off', async () => {
            withA11yOn()
            accessibilityModule.autoScanning = false

            await accessibilityModule.onBeforeExecute()

            expect(accessibilityModule.accessibilityMap.has('live-session')).toBe(false)
        })

        it('opens a BEFORE_ALL hook run the first time a scan needs a parent, once only', async () => {
            await accessibilityModule['ensurePreTestHookRun']()
            await accessibilityModule['ensurePreTestHookRun']()

            const opens = mockTrackEvent.mock.calls.filter((c) => c[1] === HookState.PRE)
            expect(opens).toHaveLength(1)
            expect(opens[0][0]).toBe(TestFrameworkState.BEFORE_ALL)
            expect((opens[0][2] as { test: { title: string } }).test.title).toContain('pre-test window')
        })

        it('reports the hook run as FAILED when the config-level before() threw', async () => {
            // WDIO swallows a throwing config hook (executeHooksWithArgs resolves with the error),
            // so the run stays exit-0 and every reporter is green. Reporting `passed` here would
            // make the dashboard assert something false rather than merely omit it.
            mockGetHookFailure.mockReturnValue('before: BOOM: config-level before hook failed')
            await accessibilityModule['ensurePreTestHookRun']()
            mockTrackEvent.mockClear()

            await accessibilityModule.onBeforeTest({ suiteTitle: 'S', test: { title: 't' } })

            const close = mockTrackEvent.mock.calls.find((c) => c[1] === HookState.POST)
            expect(close).toBeDefined()
            const result = (close![2] as { result: { passed: boolean, error?: { message: string } } }).result
            expect(result.passed).toBe(false)
            expect(result.error?.message).toContain('BOOM')
        })

        it('opens nothing while a framework hook is already the scan parent', async () => {
            accessibilityModule.currentHookRunUuid = 'framework-hook-uuid'

            await accessibilityModule['ensurePreTestHookRun']()

            expect(mockTrackEvent).not.toHaveBeenCalled()
        })

        it('closes the hook run when the first test starts, and never closes one it did not open', async () => {
            await accessibilityModule['ensurePreTestHookRun']()
            mockTrackEvent.mockClear()

            await accessibilityModule.onBeforeTest({ suiteTitle: 'S', test: { title: 't' } })

            const closes = mockTrackEvent.mock.calls.filter((c) => c[1] === HookState.POST)
            expect(closes).toHaveLength(1)
            expect((closes[0][2] as { result: { passed: boolean } }).result.passed).toBe(true)
            expect(accessibilityModule.currentHookRunUuid).toBeNull()

            mockTrackEvent.mockClear()
            await accessibilityModule.onBeforeTest({ suiteTitle: 'S', test: { title: 't2' } })
            expect(mockTrackEvent.mock.calls.filter((c) => c[1] === HookState.POST)).toHaveLength(0)
        })
    })

    describe('onSessionReload', () => {
        it('carries the scan gate over to the new session id', () => {
            accessibilityModule.accessibilityMap.set('old', true)

            accessibilityModule.onSessionReload('old', 'new')

            expect(accessibilityModule.accessibilityMap.get('new')).toBe(true)
            expect(accessibilityModule.accessibilityMap.has('old')).toBe(false)
        })

        it('preserves a gate the user had closed with stopA11yScanning', () => {
            accessibilityModule.accessibilityMap.set('old', false)

            accessibilityModule.onSessionReload('old', 'new')

            expect(accessibilityModule.accessibilityMap.get('new')).toBe(false)
        })

        it('does nothing when the old session was never registered', () => {
            accessibilityModule.onSessionReload('old', 'new')

            expect(accessibilityModule.accessibilityMap.has('new')).toBe(false)
        })

        it('ignores a no-op reload and missing ids', () => {
            accessibilityModule.accessibilityMap.set('same', true)

            accessibilityModule.onSessionReload('same', 'same')
            accessibilityModule.onSessionReload(undefined, 'new')
            accessibilityModule.onSessionReload('old', undefined)

            expect(accessibilityModule.accessibilityMap.get('same')).toBe(true)
            expect(accessibilityModule.accessibilityMap.has('new')).toBe(false)
        })
    })

    describe('scanning toggles after a reload', () => {
        it('writes the LIVE session id, not the one captured when the test started', async () => {
            // The gate is read per command from framework state, so a toggle that wrote the
            // captured id would set the dead key: stopA11yScanning() after a reload would leave
            // scanning on, and startA11yScanning() would be a silent no-op.
            vi.mocked(validateCapsWithA11y).mockReturnValue(true)
            // resetAllMocks in afterEach strips module-level implementations, so the per-test gate
            // has to be re-stated or shouldScanTest comes out undefined
            vi.mocked(shouldScanTestForAccessibility).mockReturnValue(true)
            let liveSessionId = 'session-before-reload'
            vi.mocked(AutomationFramework.getState).mockImplementation((instance, key) => {
                if (key.includes('CAPABILITIES')) {
                    return { browserName: 'chrome' }
                }
                return liveSessionId
            })

            await accessibilityModule.onBeforeTest({ suiteTitle: 'S', test: { title: 't' } })
            expect(accessibilityModule.accessibilityMap.get('session-before-reload')).toBe(true)

            // reload: framework state moves on, and onReload migrates the gate
            liveSessionId = 'session-after-reload'
            accessibilityModule.onSessionReload('session-before-reload', 'session-after-reload')

            await (mockBrowser as { stopA11yScanning: () => Promise<void> }).stopA11yScanning()

            expect(accessibilityModule.accessibilityMap.get('session-after-reload')).toBe(false)
            expect(accessibilityModule.accessibilityMap.has('session-before-reload')).toBe(false)
        })
    })

    describe('onBeforeTest', () => {
        it('should set up accessibility metadata for test', async () => {
            const mockArgs = {
                suiteTitle: 'Test Suite',
                test: { title: 'Test Case' }
            }

            await accessibilityModule.onBeforeTest(mockArgs)

            expect(TestFramework.setState).toHaveBeenCalled()
        })

        it('should handle missing test arguments gracefully', async () => {
            await accessibilityModule.onBeforeTest({})

            expect(TestFramework.setState).toHaveBeenCalled()
        })
    })

    describe('onAfterTest', () => {
        it('should handle missing test metadata gracefully', async () => {
            vi.mocked(mockTestInstance.getData).mockReturnValue(null)

            await accessibilityModule.onAfterTest()

            expect(mockBrowser.executeAsync).not.toHaveBeenCalled()
        })

        it('should return early when accessibility scan was not started', async () => {
            vi.mocked(mockTestInstance.getData).mockReturnValue({
                accessibilityScanStarted: false,
                scanTestForAccessibility: false
            })

            await accessibilityModule.onAfterTest()

            expect(mockBrowser.executeAsync).not.toHaveBeenCalled()
        })
    })

    describe('performScanCli', () => {
        it('should return early when accessibility is disabled', async () => {
            accessibilityModule.accessibility = false

            const result = await (accessibilityModule as any).performScanCli(mockBrowser)

            expect(result).toBeUndefined()
            expect(mockBrowser.execute).not.toHaveBeenCalled()
            expect(mockBrowser.executeAsync).not.toHaveBeenCalled()
        })

        it('should call execute for app accessibility', async () => {
            accessibilityModule.accessibility = true
            accessibilityModule.isAppAccessibility = true
            mockBrowser.execute.mockResolvedValue({ success: true })

            const result = await (accessibilityModule as any).performScanCli(mockBrowser)

            expect(mockBrowser.execute).toHaveBeenCalled()
            expect(result).toEqual({ success: true })
        })

        it('should call executeAsync for web accessibility', async () => {
            accessibilityModule.accessibility = true
            accessibilityModule.isAppAccessibility = false
            mockBrowser.executeAsync.mockResolvedValue({ violations: [] })

            const result = await (accessibilityModule as any).performScanCli(mockBrowser)

            expect(mockBrowser.executeAsync).toHaveBeenCalled()
            expect(result).toEqual({ violations: [] })
        })

        it('should handle errors gracefully', async () => {
            accessibilityModule.accessibility = true
            accessibilityModule.isAppAccessibility = false
            mockBrowser.executeAsync.mockRejectedValue(new Error('Scan failed'))

            const result = await (accessibilityModule as any).performScanCli(mockBrowser)

            expect(result).toBeUndefined()
        })

        it('should pass command name to executeAsync for web accessibility', async () => {
            accessibilityModule.accessibility = true
            accessibilityModule.isAppAccessibility = false
            const commandName = 'click'
            mockBrowser.executeAsync.mockResolvedValue({})

            await (accessibilityModule as any).performScanCli(mockBrowser, commandName)

            expect(mockBrowser.executeAsync).toHaveBeenCalledWith(
                'mock-perform-scan-script',
                { method: commandName }
            )
        })
    })

    describe('getA11yResults', () => {
        it('should return undefined when accessibility is disabled', async () => {
            accessibilityModule.accessibility = false

            const result = await accessibilityModule.getA11yResults(mockBrowser)

            expect(result).toBeUndefined()
            expect(mockBrowser.executeAsync).not.toHaveBeenCalled()
        })

        it('should return accessibility results when accessibility is enabled', async () => {
            accessibilityModule.accessibility = true
            const mockResults = [
                { id: 'test-1', impact: 'serious', description: 'Test violation' },
                { id: 'test-2', impact: 'moderate', description: 'Another violation' }
            ]
            mockBrowser.executeAsync.mockResolvedValue(mockResults)

            const result = await accessibilityModule.getA11yResults(mockBrowser)

            expect(mockBrowser.executeAsync).toHaveBeenCalledWith('mock-perform-scan-script', { method: '' })
            expect(mockBrowser.executeAsync).toHaveBeenCalledWith('mock-get-results-script')
            expect(result).toEqual(mockResults)
        })

        it('should handle errors gracefully and return empty array', async () => {
            accessibilityModule.accessibility = true
            mockBrowser.executeAsync.mockRejectedValue(new Error('Script execution failed'))

            const result = await accessibilityModule.getA11yResults(mockBrowser)

            expect(result).toEqual([])
        })
    })

    describe('getA11yResultsSummary', () => {
        it('should return undefined when accessibility is disabled', async () => {
            accessibilityModule.accessibility = false

            const result = await accessibilityModule.getA11yResultsSummary(mockBrowser)

            expect(result).toBeUndefined()
            expect(mockBrowser.executeAsync).not.toHaveBeenCalled()
        })

        it('should return accessibility results summary when accessibility is enabled', async () => {
            accessibilityModule.accessibility = true
            const mockSummary = {
                totalViolations: 5,
                criticalViolations: 2,
                moderateViolations: 3,
                url: 'https://example.com'
            }
            mockBrowser.executeAsync.mockResolvedValue(mockSummary)

            const result = await accessibilityModule.getA11yResultsSummary(mockBrowser)

            expect(mockBrowser.executeAsync).toHaveBeenCalledWith('mock-perform-scan-script', { method: '' })
            expect(mockBrowser.executeAsync).toHaveBeenCalledWith('mock-get-results-summary-script')
            expect(result).toEqual(mockSummary)
        })

        it('should handle errors gracefully and return empty object', async () => {
            accessibilityModule.accessibility = true
            mockBrowser.executeAsync.mockRejectedValue(new Error('Script execution failed'))

            const result = await accessibilityModule.getA11yResultsSummary(mockBrowser)

            expect(result).toEqual({})
        })
    })

    // SDK-3813 (+ follow-up APPA11Y-5542): App Automate + App Accessibility sessions are detected
    // from caps (like the classic flow) and take the app validation/scan path (not the Chrome-only
    // web gate). Unlike the original SDK-3813 fix, per-command wrapping is NOT skipped for app: it is
    // applied with each overwriteCommand individually guarded, so the commands appium DOES register
    // (click, setValue, ...) auto-scan, while a command the driver doesn't register is skipped
    // instead of aborting onBeforeExecute. This restores per-command app auto-scanning.
    describe('onBeforeExecute - App Automate (SDK-3813)', () => {
        const appGetState = (instance: any, key: string) => {
            if (key.includes('input_capabilities')) {
                return { 'appium:app': 'bs://BrowserStackMobileAppId' }
            }
            if (key.includes('capabilities')) {
                return { platformName: 'android', platformVersion: '13' }
            }
            if (key.includes('session_id')) {
                return 12345
            }
            return {}
        }

        afterEach(() => {
            accessibilityScripts.commandsToWrap = []
        })

        it('detects app session from caps and wraps commands for per-command auto-scan', async () => {
            // binary flag is false; caps say app -> module must still take app path
            vi.mocked(validateCapsWithAppA11y).mockReturnValue(true)
            vi.mocked(validateCapsWithA11y).mockReturnValue(true)
            accessibilityScripts.commandsToWrap = [
                { name: 'click', class: 'Browser' },
                { name: 'startA11yScanning', class: 'Browser' }
            ]
            vi.mocked(AutomationFramework.getState).mockImplementation(appGetState as any)

            await accessibilityModule.onBeforeExecute()

            expect(accessibilityModule.isAppAccessibility).toBe(true)
            // App sessions wrap commands too, so DOM commands (click, ...) auto-scan per-command.
            expect(mockBrowser.overwriteCommand).toHaveBeenCalled()
            // Chrome-only web gate never consulted; app validation used
            expect(validateCapsWithAppA11y).toHaveBeenCalled()
            expect(validateCapsWithA11y).not.toHaveBeenCalled()
        })

        it('engages the app performScan path (execute, not web executeAsync)', async () => {
            vi.mocked(validateCapsWithAppA11y).mockReturnValue(true)
            vi.mocked(validateCapsWithA11y).mockReturnValue(true)
            vi.mocked(AutomationFramework.getState).mockImplementation(appGetState as any)
            mockBrowser.execute.mockResolvedValue({ scanned: true })

            await accessibilityModule.onBeforeExecute()
            const result = await mockBrowser.performScan()

            expect(mockBrowser.execute).toHaveBeenCalled()
            expect(mockBrowser.executeAsync).not.toHaveBeenCalled()
            expect(result).toEqual({ scanned: true })
        })

        it('does not abort onBeforeExecute when an individual command wrap throws', async () => {
            vi.mocked(validateCapsWithAppA11y).mockReturnValue(true)
            vi.mocked(validateCapsWithA11y).mockReturnValue(true)
            accessibilityScripts.commandsToWrap = [{ name: 'startA11yScanning', class: 'Browser' }]
            mockBrowser.overwriteCommand = vi.fn(() => {
                throw new Error('overwriteCommand: no command to be overwritten: startA11yScanning')
            })
            const errorSpy = vi.spyOn(accessibilityModule.logger, 'error')
            vi.mocked(AutomationFramework.getState).mockImplementation(appGetState as any)

            await accessibilityModule.onBeforeExecute()

            // The wrap IS attempted (and throws for this unregistered command), but the per-command
            // try/catch swallows it so the wrap loop and onBeforeExecute complete without hitting the
            // outer error handler.
            expect(mockBrowser.overwriteCommand).toHaveBeenCalled()
            expect(errorSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('Error in onBeforeExecute')
            )
        })
    })

    // APPA11Y-5542: scans fired inside test hooks must carry the hook's run uuid
    // (thHookRunUuid) so the backend (SeleniumHub appAllyScan -> hook_run_uuid) can
    // reconcile them onto the wrapping test. onHookStart captures the uuid + opens the
    // scan gate for the hook window; onHookEnd clears it so test-body scans are unstamped.
    describe('onHookStart / onHookEnd (hook scans)', () => {
        it('registers hook observers for every hook lifecycle state (PRE + POST)', () => {
            for (const state of [
                TestFrameworkState.BEFORE_ALL,
                TestFrameworkState.BEFORE_EACH,
                TestFrameworkState.AFTER_EACH,
                TestFrameworkState.AFTER_ALL
            ]) {
                expect(TestFramework.registerObserver).toHaveBeenCalledWith(state, HookState.PRE, expect.any(Function))
                expect(TestFramework.registerObserver).toHaveBeenCalledWith(state, HookState.POST, expect.any(Function))
            }
        })

        it('captures the hook run uuid and opens the scan gate at hook start', async () => {
            vi.mocked(TestFramework.getState).mockReturnValue('hook-uuid-123')
            vi.mocked(AutomationFramework.getState).mockImplementation((instance: any, key: string) =>
                (key.includes('session_id') ? 12345 : {}) as any)

            await accessibilityModule.onHookStart({ instance: mockTestInstance } as any)

            expect(accessibilityModule.currentHookRunUuid).toBe('hook-uuid-123')
            expect(accessibilityModule.accessibilityMap.get(12345)).toBe(true)
        })

        it('does not open the scan gate when accessibility is disabled', async () => {
            accessibilityModule.accessibility = false
            vi.mocked(TestFramework.getState).mockReturnValue('hook-uuid-123')

            await accessibilityModule.onHookStart({ instance: mockTestInstance } as any)

            expect(accessibilityModule.currentHookRunUuid).toBe('hook-uuid-123')
            expect(accessibilityModule.accessibilityMap.get(12345)).toBeUndefined()
        })

        it('clears the hook run uuid at hook end so later test-body scans are unstamped', async () => {
            accessibilityModule.currentHookRunUuid = 'hook-uuid-123'

            await accessibilityModule.onHookEnd()

            expect(accessibilityModule.currentHookRunUuid).toBeNull()
        })

        it('threads the hook run uuid into the app scan payload (thHookRunUuid)', async () => {
            accessibilityModule.accessibility = true
            accessibilityModule.isAppAccessibility = true
            mockBrowser.execute.mockResolvedValue({ scanned: true })

            await (accessibilityModule as any).performScanCli(mockBrowser, 'click', 'hook-uuid-99')

            expect(_getParamsForAppAccessibility).toHaveBeenCalledWith('click', undefined, 'hook-uuid-99')
        })

        it('passes no hook uuid for an ordinary (non-hook) app scan', async () => {
            accessibilityModule.accessibility = true
            accessibilityModule.isAppAccessibility = true
            mockBrowser.execute.mockResolvedValue({ scanned: true })

            await (accessibilityModule as any).performScanCli(mockBrowser, 'click')

            expect(_getParamsForAppAccessibility).toHaveBeenCalledWith('click', undefined, undefined)
        })
    })
})