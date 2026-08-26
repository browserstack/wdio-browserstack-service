/// <reference path="../../webdriverio/src/@types/async.d.ts" />
/// <reference path="../src/@types/bstack-service-types.d.ts" />
import path from 'node:path'

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import logger from '@wdio/logger'

import AccessibilityHandler from '../src/accessibility-handler.js'
import type { BrowserstackConfig, BrowserstackOptions } from '../src/types.js'
import type { Options } from '@wdio/types'
import * as utils from '../src/util.js'
import type { Capabilities } from '@wdio/types'
import * as bstackLogger from '../src/bstackLogger.js'

const log = logger('test')
let accessibilityHandler: AccessibilityHandler
let browser: WebdriverIO.Browser | WebdriverIO.MultiRemoteBrowser
let options: BrowserstackConfig & BrowserstackOptions
let config : Options.Testrunner
let caps: Capabilities.RemoteCapability
let accessibilityOpts: { [key: string]: any; }

vi.mock('fetch')
vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))
vi.useFakeTimers().setSystemTime(new Date('2020-01-01'))
vi.mock('uuid', () => ({ v4: () => '123456789' }))

const bstackLoggerSpy = vi.spyOn(bstackLogger.BStackLogger, 'logToFile')
bstackLoggerSpy.mockImplementation(() => {})

describe('shouldSkipScanForBidiWindowCommand (SDK-5047)', () => {
    const skip = (b: any, c: any) => (AccessibilityHandler as any).shouldSkipScanForBidiWindowCommand(b, c)

    it('skips the injected a11y scan for window/context commands on BiDi sessions', () => {
        for (const name of ['getWindowHandle', 'getWindowHandles', 'switchToWindow', 'switchWindow', 'newWindow', 'closeWindow', 'switchFrame', 'switchToFrame', 'switchToParentFrame']) {
            expect(skip({ isBidi: true }, { name, class: 'Browser' })).toBe(true)
        }
    })

    it('does not skip for non-window commands on BiDi sessions', () => {
        expect(skip({ isBidi: true }, { name: 'click', class: 'Element' })).toBe(false)
        expect(skip({ isBidi: true }, { name: 'url', class: 'Browser' })).toBe(false)
        expect(skip({ isBidi: true }, { name: 'execute', class: 'Browser' })).toBe(false)
    })

    it('does not skip on non-BiDi sessions even for window commands', () => {
        expect(skip({ isBidi: false }, { name: 'getWindowHandle', class: 'Browser' })).toBe(false)
        expect(skip({}, { name: 'switchToWindow', class: 'Browser' })).toBe(false)
    })

    it('is safe with undefined browser or missing command name', () => {
        expect(skip(undefined, { name: 'getWindowHandle', class: 'Browser' })).toBe(false)
        expect(skip({ isBidi: true }, {})).toBe(false)
    })

    it('skips for window commands when any multiremote child instance is BiDi', () => {
        const multi = { instances: ['chromeA', 'chromeB'], chromeA: { isBidi: false }, chromeB: { isBidi: true } }
        expect(skip(multi, { name: 'getWindowHandle', class: 'Browser' })).toBe(true)
        expect(skip(multi, { name: 'switchToWindow', class: 'Browser' })).toBe(true)
    })

    it('does not skip on multiremote when no child instance is BiDi', () => {
        const multi = { instances: ['chromeA', 'chromeB'], chromeA: { isBidi: false }, chromeB: {} }
        expect(skip(multi, { name: 'getWindowHandle', class: 'Browser' })).toBe(false)
    })
})

beforeEach(() => {
    vi.mocked(log.info).mockClear()
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockReturnValue(Promise.resolve(Response.json({ automation_session: {
        browser_url: 'https://www.browserstack.com/automate/builds/1/sessions/2'
    } })))

    browser = {
        sessionId: 'session123',
        config: {},
        capabilities: {
            device: '',
            os: 'OS X',
            os_version: 'Catalina',
            browserName: 'chrome'
        },
        instances: ['browserA', 'browserB'],
        isMultiremote: false,
        browserA: {
            sessionId: 'session456',
            capabilities: { 'bstack:options': {
                device: '',
                os: 'Windows',
                osVersion: 10,
                browserName: 'chrome'
            } }
        },
        getInstance: vi.fn().mockImplementation((browserName: string) => browser[browserName]),
        browserB: {},
        execute: vi.fn(),
        executeAsync: async () => { 'done' },
        getUrl: () => { return 'https://www.google.com/'},
        on: vi.fn(),
    } as unknown as WebdriverIO.Browser | WebdriverIO.MultiRemoteBrowser
    caps = {
        browserName: 'chrome',
        'bstack:options': {
            os: 'OS X',
            osVersion: 'Catalina',
            accessibility: true
        } } as Capabilities.RemoteCapability
    options = {
        accessibility: true
    }
    config = {}
    accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'framework', true)
})

it('should initialize correctly', () => {
    accessibilityOpts = {
        wcagVersion: 'wcag2a',
        includeIssueType: {
            bestPractice: true,
            needsReview: true
        }
    }
    accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'framework', true, false, accessibilityOpts)
    expect(accessibilityHandler['_platformA11yMeta']).toEqual({ browser_name: 'chrome', browser_version: 'latest', os_name: 'OS X', os_version: 'Catalina' })
    expect(accessibilityHandler['_accessibility']).toEqual(true)
    expect(accessibilityHandler['_caps']).toEqual(caps)
    expect(accessibilityHandler['_framework']).toEqual('framework')
})

describe('before', () => {
    // let _getCapabilityValueSpy
    const isBrowserstackSessionSpy = vi.spyOn(utils, 'isBrowserstackSession')
    const getA11yResultsSummarySpy = vi.spyOn(utils, 'getA11yResultsSummary')
    const shouldAddServiceVersionSpy = vi.spyOn(utils, 'shouldAddServiceVersion')
    const getA11yResultsSpy = vi.spyOn(utils, 'getA11yResults')
    const isAccessibilityAutomationSessionSpy = vi.spyOn(utils, 'isAccessibilityAutomationSession')

    beforeEach(() => {
        accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'framework', true, false, accessibilityOpts)
        getA11yResultsSpy.mockClear()
        isBrowserstackSessionSpy.mockClear()
        getA11yResultsSummarySpy.mockClear()
        isAccessibilityAutomationSessionSpy.mockClear()
    })

    it('calls isBrowserstackSession', async () => {
        isBrowserstackSessionSpy.mockReturnValue(true)
        await accessibilityHandler.before('session123')
        expect(isBrowserstackSessionSpy).toBeCalledTimes(0)
    })

    it('isBrowserstackSession returns true', async () => {
        isBrowserstackSessionSpy.mockReturnValue(true)
        await accessibilityHandler.before('session123')
        expect(isBrowserstackSessionSpy).toBeCalledTimes(0)
    })

    it('calls isAccessibilityAutomationSession', async () => {
        isBrowserstackSessionSpy.mockReturnValue(true)
        await accessibilityHandler.before('session123')
        expect(isAccessibilityAutomationSessionSpy).toBeCalledTimes(2)
    })

    it('calls validateCapsWithA11y', async () => {
        const _getCapabilityValueSpy = vi.spyOn(accessibilityHandler, '_getCapabilityValue').mockReturnValue(true)
        const validateCapsWithA11ySpy = vi.spyOn(utils, 'validateCapsWithA11y')
        shouldAddServiceVersionSpy.mockReturnValue(true)
        isBrowserstackSessionSpy.mockReturnValue(true)
        isAccessibilityAutomationSessionSpy.mockReturnValue(true)
        await accessibilityHandler.before('session123')
        expect(_getCapabilityValueSpy).toBeCalledTimes(3)
        expect(validateCapsWithA11ySpy).toBeCalledTimes(1)
    })

    it('calls validateCapsWithNonBstackA11y', async () => {
        const validateCapsWithNonBstackA11ySpy = vi.spyOn(utils, 'validateCapsWithNonBstackA11y')
        shouldAddServiceVersionSpy.mockReturnValue(false)
        isAccessibilityAutomationSessionSpy.mockReturnValue(true)
        await accessibilityHandler.before('session123')
        expect(validateCapsWithNonBstackA11ySpy).toBeCalledTimes(1)
    })

    it('calls getA11yResultsSummary', async () => {
        isBrowserstackSessionSpy.mockReturnValue(true)
        isAccessibilityAutomationSessionSpy.mockReturnValue(true)
        await accessibilityHandler.before('session123');
        (browser as WebdriverIO.Browser).getAccessibilityResultsSummary()
        expect(getA11yResultsSummarySpy).toBeCalledTimes(1)
    })

    it('calls getA11yResults', async () => {
        isBrowserstackSessionSpy.mockReturnValue(true)
        isAccessibilityAutomationSessionSpy.mockReturnValue(true)
        await accessibilityHandler.before('session123');
        (browser as WebdriverIO.Browser).getAccessibilityResults()
        expect(getA11yResultsSpy).toBeCalledTimes(1)
    })
})

describe('beforeScenario', () => {
    let executeAsyncSpy: any
    let executeSpy: any

    beforeEach(() => {
        accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'framework', true, false, accessibilityOpts)
        executeAsyncSpy = vi.spyOn((browser as WebdriverIO.Browser), 'executeAsync')
        executeSpy = vi.spyOn((browser as WebdriverIO.Browser), 'execute')
        vi.spyOn(utils, 'isBrowserstackSession').mockReturnValue(true)
        vi.spyOn(utils, 'isAccessibilityAutomationSession').mockReturnValue(true)
        vi.spyOn(utils, 'getUniqueIdentifierForCucumber').mockReturnValue('test title')
    })

    it('should execute test started if page opened and can scan the page', async () => {
        const logInfoMock = vi.spyOn(log, 'info')
        vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(true)

        await accessibilityHandler.beforeScenario({
            pickle: {
                name: 'pickle-name',
                tags: []
            },
            gherkinDocument: {
                uri: '',
                feature: {
                    name: 'feature-name',
                    description: ''
                }
            }
        } as any)

        expect(logInfoMock.mock.calls[0][0])
            .toContain('Automate test case execution has started.')
    })

    it('should not execute test started if url is invalid', async () => {
        browser.getUrl = async () => {
            return ':data;'
        }

        vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(false)

        await accessibilityHandler.beforeScenario({
            pickle: {
                name: 'pickle-name',
                tags: []
            },
            gherkinDocument: {
                uri: '',
                feature: {
                    name: 'feature-name',
                    description: ''
                }
            }
        } as any)

        expect(executeSpy).toBeCalledTimes(0)
        expect(executeAsyncSpy).toBeCalledTimes(0)
    })

    it('should not execute test started if page opened but cannot start scan', async () => {
        vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(false)

        await accessibilityHandler.beforeScenario({
            pickle: {
                name: 'pickle-name',
                tags: []
            },
            gherkinDocument: {
                uri: '',
                feature: {
                    name: 'feature-name',
                    description: ''
                }
            }
        } as any)

        expect(executeSpy).toBeCalledTimes(0)
    })

    it('should not execute test started if shouldRunTestHooks is false', async () => {
        accessibilityHandler['shouldRunTestHooks'] = vi.fn().mockImplementation(() => { return false })
        await accessibilityHandler.beforeScenario({
            pickle: {
                name: 'pickle-name',
                tags: []
            },
            gherkinDocument: {
                uri: '',
                feature: {
                    name: 'feature-name',
                    description: ''
                }
            }
        } as any)

        expect(executeSpy).toBeCalledTimes(0)
    })

    it('should throw error in before scenario if exception occurs', async () => {
        const logErrorMock = vi.spyOn(bstackLogger.BStackLogger, 'error')

        vi.spyOn(utils, 'isBrowserstackSession').mockReturnValue(true)
        vi.spyOn(utils, 'isAccessibilityAutomationSession').mockReturnValue(true)
        vi.spyOn(utils, 'getUniqueIdentifierForCucumber').mockReturnValue('test-id')
        vi.spyOn(utils, 'shouldScanTestForAccessibility').mockImplementation(() => {
            throw new Error('Test Error')
        })

        accessibilityHandler['_accessibility'] = true
        accessibilityHandler['_sessionId'] = 'session123'

        await accessibilityHandler.beforeScenario({
            pickle: {
                name: 'pickle-name',
                tags: []
            },
            gherkinDocument: {
                uri: '',
                feature: {
                    name: 'feature-name',
                    description: ''
                }
            }
        } as any)

        expect(logErrorMock).toHaveBeenCalled()
        expect(logErrorMock.mock.calls[0][0])
            .toContain('Exception in starting accessibility automation scan for this test case')
    })
})

describe('afterScenario', () => {
    let executeAsyncSpy: any
    let accessibilityHandler: AccessibilityHandler

    beforeEach(() => {
        accessibilityHandler = new AccessibilityHandler(browser, caps, false, 'framework', true, accessibilityOpts)
        executeAsyncSpy = vi.spyOn((browser as WebdriverIO.Browser), 'executeAsync')
        vi.spyOn(utils, 'isBrowserstackSession').mockReturnValue(true)
        vi.spyOn(utils, 'isAccessibilityAutomationSession').mockReturnValue(true)
        vi.spyOn(utils, 'getUniqueIdentifierForCucumber').mockReturnValue('test title')
        accessibilityHandler['_testMetadata']['test title'] = {
            accessibilityScanStarted: true,
            scanTestForAccessibility: true
        }
        accessibilityHandler['sendTestStopEvent'] = vi.fn().mockImplementation(() => { return [] })
    })

    it('should execute test end if scanTestForAccessibility is true', async () => {
        const logInfoMock = vi.spyOn(log, 'info')

        await accessibilityHandler.afterScenario({
            pickle: {
                name: 'pickle-name',
                tags: []
            },
            gherkinDocument: {
                uri: '',
                feature: {
                    name: 'feature-name',
                    description: ''
                }
            }
        } as any)

        expect(accessibilityHandler['sendTestStopEvent']).toBeCalledTimes(1)
        expect(logInfoMock.mock.calls[1][0])
            .toContain('Accessibility testing for this test case has ended.')
    })

    it('should return if shouldRunTestHooks is false', async () => {
        accessibilityHandler['shouldRunTestHooks'] = vi.fn().mockImplementation(() => { return false })
        await accessibilityHandler.afterScenario({
            pickle: {
                name: 'pickle-name',
                tags: []
            },
            gherkinDocument: {
                uri: '',
                feature: {
                    name: 'feature-name',
                    description: ''
                }
            }
        } as any)

        expect(executeAsyncSpy).toBeCalledTimes(0)
    })

    it('should return if accessibilityScanStarted is false', async () => {
        accessibilityHandler['_testMetadata']['test title'] = {
            accessibilityScanStarted: false,
            scanTestForAccessibility: true
        }
        await accessibilityHandler.afterScenario({
            pickle: {
                name: 'pickle-name',
                tags: []
            },
            gherkinDocument: {
                uri: '',
                feature: {
                    name: 'feature-name',
                    description: ''
                }
            }
        } as any)

        expect(executeAsyncSpy).toBeCalledTimes(0)
    })

    it('should throw error in after scenario if exception occurs', async () => {
        const logErrorMock = vi.spyOn(log, 'error')
        accessibilityHandler['sendTestStopEvent'] = vi.fn().mockImplementation(() => { throw new Error() })

        await accessibilityHandler.afterScenario({
            pickle: {
                name: 'pickle-name',
                tags: []
            },
            gherkinDocument: {
                uri: '',
                feature: {
                    name: 'feature-name',
                    description: ''
                }
            }
        } as any)

        expect(logErrorMock.mock.calls[0][0])
            .toContain('Accessibility results could not be processed for the test case')
    })
})

describe('beforeHook / afterHook (hook scans)', () => {
    beforeEach(() => {
        accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'mocha', true, false, accessibilityOpts)
        vi.spyOn(utils, 'isBrowserstackSession').mockReturnValue(true)
        vi.spyOn(utils, 'isAccessibilityAutomationSession').mockReturnValue(true)
        accessibilityHandler['_sessionId'] = 'session123'
    })

    it('stamps the hook run uuid inside a supported mocha per-test hook', async () => {
        vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(true)
        await accessibilityHandler.beforeHook(
            { title: '"before each" hook', parent: 'suite' } as any,
            { currentTest: { parent: 'suite', title: 'test' } },
            'hook-uuid-1'
        )
        expect(accessibilityHandler['_currentHookRunUuid']).toBe('hook-uuid-1')
    })

    it('clears the hook run uuid on afterHook so test-body scans are not stamped', async () => {
        await accessibilityHandler.beforeHook(
            { title: '"after each" hook', parent: 'suite' } as any,
            { currentTest: { parent: 'suite', title: 'test' } },
            'hook-uuid-2'
        )
        expect(accessibilityHandler['_currentHookRunUuid']).toBe('hook-uuid-2')
        await accessibilityHandler.afterHook({ title: '"after each" hook' } as any, {}, { passed: true } as any, 'hook-uuid-2')
        expect(accessibilityHandler['_currentHookRunUuid']).toBeNull()
    })

    it('does not stamp when the framework does not support hooks', async () => {
        const jasmineHandler = new AccessibilityHandler(browser, caps, options, false, config, 'jasmine', true, false, accessibilityOpts)
        jasmineHandler['_sessionId'] = 'session123'
        await jasmineHandler.beforeHook({ title: '"before each" hook' } as any, {}, 'hook-uuid-3')
        expect(jasmineHandler['_currentHookRunUuid']).toBeNull()
    })

    it('actually PASSES the hook uuid to performA11yScan for a scan fired inside a hook', async () => {
        vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(true)
        const scanSpy = vi.spyOn(utils, 'performA11yScan').mockResolvedValue(undefined)
        // enter a hook window -> sets the scan gate + _currentHookRunUuid
        await accessibilityHandler.beforeHook(
            { title: '"before each" hook', parent: 'suite' } as any,
            { currentTest: { parent: 'suite', title: 'test' } },
            'hook-uuid-42'
        )
        // simulate a wrapped DOM-changing command running inside the hook
        const orig = vi.fn().mockResolvedValue('ok')
        await accessibilityHandler['commandWrapper']({ name: 'click', class: 'Element' } as any, undefined as any, orig, 'arg')
        expect(scanSpy).toHaveBeenCalled()
        const lastCall = scanSpy.mock.calls[scanSpy.mock.calls.length - 1]
        // performA11yScan(isAppAutomate, browser, isBS, isA11y, commandName, testName, hookRunUuid)
        expect(lastCall[lastCall.length - 1]).toBe('hook-uuid-42')
    })

    it('does NOT stamp a hook uuid on a test-body scan (afterHook cleared it)', async () => {
        vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(true)
        const scanSpy = vi.spyOn(utils, 'performA11yScan').mockResolvedValue(undefined)
        await accessibilityHandler.beforeHook(
            { title: '"before each" hook', parent: 'suite' } as any,
            { currentTest: { parent: 'suite', title: 'test' } },
            'hook-uuid-77'
        )
        await accessibilityHandler.afterHook() // hook ends -> uuid cleared, gate remains on
        const orig = vi.fn().mockResolvedValue('ok')
        await accessibilityHandler['commandWrapper']({ name: 'click', class: 'Element' } as any, undefined as any, orig, 'arg')
        expect(scanSpy).toHaveBeenCalled()
        const lastCall = scanSpy.mock.calls[scanSpy.mock.calls.length - 1]
        expect(lastCall[lastCall.length - 1]).toBeNull()
    })

    it('_getParamsForAppAccessibility puts the hook uuid on the scan payload as thHookRunUuid', () => {
        expect(utils._getParamsForAppAccessibility('click', 'testName', 'hook-uuid-9').thHookRunUuid).toBe('hook-uuid-9')
        expect(utils._getParamsForAppAccessibility('click', 'testName').thHookRunUuid).toBeUndefined()
    })
})

describe('beforeTest', () => {
    let executeAsyncSpy: any
    let executeSpy: any

    describe('mocha', () => {
        beforeEach(() => {
            accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'mocha', true, false, accessibilityOpts)
            vi.spyOn(utils, 'isBrowserstackSession').mockReturnValue(true)
            vi.spyOn(utils, 'isAccessibilityAutomationSession').mockReturnValue(true)
            vi.spyOn(utils, 'getUniqueIdentifier').mockReturnValue('test title')

            executeAsyncSpy = vi.spyOn((browser as WebdriverIO.Browser), 'executeAsync')
            executeSpy = vi.spyOn((browser as WebdriverIO.Browser), 'execute')
        })

        it('should execute test started if page opened and can scan the page', async () => {
            const logInfoMock = vi.spyOn(log, 'info')
            vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(true)
            accessibilityHandler['sendTestStartEvent'] = vi.fn().mockImplementation(() => { return [] })

            await accessibilityHandler.beforeTest('suite title', { parent: 'parent', title: 'test' } as any)

            expect(logInfoMock.mock.calls[0][0])
                .toContain('Automate test case execution has started.')
            vi.fn().mockRestore()
        })

        it('should not execute test started if url is invalid', async () => {
            browser.getUrl = async () => {
                return ':data;'
            }

            vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(false)
            await accessibilityHandler.beforeTest('suite title', { parent: 'parent', title: 'test' } as any)

            expect(executeSpy).toBeCalledTimes(0)
            expect(executeAsyncSpy).toBeCalledTimes(0)
        })

        it('should not execute test started if page opened but cannot start scan', async () => {
            vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(false)
            await accessibilityHandler.beforeTest('suite title', { parent: 'parent', title: 'test' } as any)

            expect(executeSpy).toBeCalledTimes(0)
        })

        it('should not execute test started if shouldRunTestHooks is false', async () => {
            accessibilityHandler['shouldRunTestHooks'] = vi.fn().mockImplementation(() => { return false })
            await accessibilityHandler.beforeTest('suite title', { parent: 'parent', title: 'test' } as any)

            expect(executeSpy).toBeCalledTimes(0)
        })

        it('should throw error in before test if exception occurs', async () => {
            const logErrorMock = vi.spyOn(log, 'error')
            vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(true)
            accessibilityHandler['shouldRunTestHooks'] = vi.fn().mockImplementation(() => { throw new Error() })
            await accessibilityHandler.beforeTest('suite title', { parent: 'parent', title: 'test' } as any)

            expect(logErrorMock.mock.calls[0][0])
                .toContain('Exception in starting accessibility automation scan for this test case Error')
        })
    })

    describe('jasmine', () => {
        beforeEach(() => {
            accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'jasmine', true, false, accessibilityOpts)
            vi.spyOn(utils, 'isBrowserstackSession').mockReturnValue(true)
            vi.spyOn(utils, 'isAccessibilityAutomationSession').mockReturnValue(true)
            vi.spyOn(utils, 'getUniqueIdentifier').mockReturnValue('suite title test')
        })

        it('should start scan orchestration for jasmine like mocha (SDK-7190)', async () => {
            const logInfoMock = vi.spyOn(log, 'info')
            const shouldScanSpy = vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(true)

            /* jasmine test objects have `description`/`fullName`, no `title`/`parent` */
            await accessibilityHandler.beforeTest('suite title', { description: 'test', fullName: 'suite title test' } as any)

            expect(shouldScanSpy).toBeCalledWith('suite title', 'test', accessibilityOpts)
            expect(logInfoMock.mock.calls[0][0])
                .toContain('Automate test case execution has started.')
            expect(accessibilityHandler['_testMetadata']['suite title test']).toEqual({
                scanTestForAccessibility: true,
                accessibilityScanStarted: true
            })
        })

        it('should arm the a11y scan session map so command scans fire (SDK-7190)', async () => {
            vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(true)
            accessibilityHandler['_sessionId'] = 'session123'

            await accessibilityHandler.beforeTest('suite title', { description: 'test', fullName: 'suite title test' } as any)

            expect(AccessibilityHandler['_a11yScanSessionMap']['session123']).toBe(true)
        })
    })

    describe('cucumber', () => {
        it('should not run beforeTest orchestration for cucumber', async () => {
            accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'cucumber', true, false, accessibilityOpts)
            vi.spyOn(utils, 'isAccessibilityAutomationSession').mockReturnValue(true)
            const shouldScanSpy = vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(true)

            await accessibilityHandler.beforeTest('suite title', { parent: 'parent', title: 'test' } as any)

            expect(shouldScanSpy).toBeCalledTimes(0)
        })
    })
})

describe('afterTest', () => {
    let executeAsyncSpy: any
    let accessibilityHandler: AccessibilityHandler

    beforeEach(() => {
        accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'mocha', true, false, accessibilityOpts)
        executeAsyncSpy = vi.spyOn((browser as WebdriverIO.Browser), 'executeAsync')
        vi.spyOn(utils, 'isBrowserstackSession').mockReturnValue(true)
        vi.spyOn(utils, 'isAccessibilityAutomationSession').mockReturnValue(true)
        vi.spyOn(utils, 'getUniqueIdentifier').mockReturnValue('test title')

        accessibilityHandler['_testMetadata']['test title'] = {
            accessibilityScanStarted: true,
            scanTestForAccessibility: true
        }
    })

    it('should execute test end if scanTestForAccessibility is true', async () => {
        const logInfoMock = vi.spyOn(log, 'info')
        await accessibilityHandler.afterTest('suite title', { parent: 'parent', title: 'test' } as any)

        expect(logInfoMock.mock.calls[1][0])
            .toContain('Accessibility testing for this test case has ended.')
    })

    it('should not return if accessibilityScanStarted is false', async () => {
        accessibilityHandler['shouldRunTestHooks'] = vi.fn().mockImplementation(() => { return false })
        await accessibilityHandler.afterTest('suite title', { parent: 'parent', title: 'test' } as any)

        expect(executeAsyncSpy).toBeCalledTimes(0)
    })

    it('should not return if shouldRunTestHooks is false', async () => {
        accessibilityHandler['_testMetadata']['test title'] = {
            accessibilityScanStarted: false,
            scanTestForAccessibility: true
        }
        await accessibilityHandler.afterTest('suite title', { parent: 'parent', title: 'test' } as any)

        expect(executeAsyncSpy).toBeCalledTimes(0)
    })

    it('should throw error in after test if exception occurs', async () => {
        const logErrorMock = vi.spyOn(log, 'error')
        accessibilityHandler['shouldRunTestHooks'] = vi.fn().mockImplementation(() => { return true })
        accessibilityHandler['sendTestStopEvent'] = vi.fn().mockImplementation(() => { throw new Error() })
        await accessibilityHandler.afterTest('suite title', { parent: 'parent', title: 'test' } as any)

        expect(logErrorMock.mock.calls[0][0])
            .toContain('Accessibility results could not be processed for the test case test. Error :')
    })

    it('should send test stop event for jasmine (SDK-7190)', async () => {
        accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'jasmine', true, false, accessibilityOpts)
        vi.spyOn(utils, 'isAccessibilityAutomationSession').mockReturnValue(true)
        vi.spyOn(utils, 'getUniqueIdentifier').mockReturnValue('test title')
        accessibilityHandler['_testMetadata']['test title'] = {
            accessibilityScanStarted: true,
            scanTestForAccessibility: true
        }
        const sendStop = vi.fn()
        accessibilityHandler['sendTestStopEvent'] = sendStop

        await accessibilityHandler.afterTest('suite title', { description: 'test', fullName: 'suite title test' } as any)

        expect(sendStop).toBeCalledTimes(1)
    })
})

describe('pre-test scan gate (non-CLI flow)', () => {
    beforeEach(() => {
        accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'mocha', true, false, accessibilityOpts)
        vi.spyOn(utils, 'isBrowserstackSession').mockReturnValue(true)
        vi.spyOn(utils, 'isAccessibilityAutomationSession').mockReturnValue(true)
        vi.spyOn(utils, 'validateCapsWithA11y').mockReturnValue(true)
    })

    it('opens the gate in before(), so config-level hook commands scan', async () => {
        await accessibilityHandler.before('session-direct')

        expect(AccessibilityHandler['_a11yScanSessionMap']['session-direct']).toBe(true)
    })

    it('leaves it closed when autoScanning is off', async () => {
        const handler = new AccessibilityHandler(browser, caps, options, false, config, 'mocha', true, false,
            { ...accessibilityOpts, autoScanning: false } as never)

        await handler.before('session-noauto')

        expect(AccessibilityHandler['_a11yScanSessionMap']['session-noauto']).toBeUndefined()
    })

    it('is recomputed per test, so a filtered test still closes it', async () => {
        await accessibilityHandler.before('session-direct-2')
        expect(AccessibilityHandler['_a11yScanSessionMap']['session-direct-2']).toBe(true)

        vi.spyOn(utils, 'shouldScanTestForAccessibility').mockReturnValue(false)
        await accessibilityHandler.beforeTest('suite', { title: 'excluded', parent: 'suite' } as never)

        expect(AccessibilityHandler['_a11yScanSessionMap']['session-direct-2']).toBe(false)
    })
})

describe('onSessionReload', () => {
    beforeEach(() => {
        accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'framework', true, false, accessibilityOpts)
    })

    it('moves the scan flag and the tracked session id onto the reloaded session', () => {
        accessibilityHandler['_sessionId'] = 'old-session'
        AccessibilityHandler['_a11yScanSessionMap']['old-session'] = true

        accessibilityHandler.onSessionReload('old-session', 'new-session')

        expect(AccessibilityHandler['_a11yScanSessionMap']['new-session']).toBe(true)
        expect(AccessibilityHandler['_a11yScanSessionMap']['old-session']).toBeUndefined()
        expect(accessibilityHandler['_sessionId']).toBe('new-session')
    })

    it('makes the scanning toggles address the reloaded session', async () => {
        // commandWrapper reads `this._sessionId`, so a toggle writing the id captured in before()
        // would set the dead key — stop would not stop, start would not start.
        // before() is what installs the toggles on the driver, so it has to run first
        vi.spyOn(utils, 'isBrowserstackSession').mockReturnValue(true)
        await accessibilityHandler.before('old-session')
        accessibilityHandler['_testIdentifier'] = 'test-1'
        AccessibilityHandler['_a11yScanSessionMap']['old-session'] = true

        accessibilityHandler.onSessionReload('old-session', 'new-session')
        const browserWithA11y = browser as unknown as { stopA11yScanning: () => Promise<void> }
        await browserWithA11y.stopA11yScanning()

        expect(AccessibilityHandler['_a11yScanSessionMap']['new-session']).toBe(false)
    })

    it('is a no-op for a reload that changes nothing', () => {
        accessibilityHandler['_sessionId'] = 'same'
        AccessibilityHandler['_a11yScanSessionMap']['same'] = true

        accessibilityHandler.onSessionReload('same', 'same')

        expect(AccessibilityHandler['_a11yScanSessionMap']['same']).toBe(true)
        expect(accessibilityHandler['_sessionId']).toBe('same')
    })
})

describe('getIdentifier', () => {
    let getUniqueIdentifierSpy: any
    let getUniqueIdentifierForCucumberSpy: any

    beforeEach(() => {
        accessibilityHandler = new AccessibilityHandler(browser, caps, options, false, config, 'framework', true, false, accessibilityOpts)

        getUniqueIdentifierSpy = vi.spyOn(utils, 'getUniqueIdentifier')
        getUniqueIdentifierForCucumberSpy = vi.spyOn(utils, 'getUniqueIdentifierForCucumber')
    })

    it('non cucumber', () => {
        accessibilityHandler['getIdentifier']({ parent: 'parent', title: 'title' } as any)
        expect(getUniqueIdentifierSpy).toBeCalledTimes(1)
    })

    it('cucumber', () => {
        accessibilityHandler['getIdentifier']({ pickle: { uri: 'uri', astNodeIds: ['9', '8'] } } as any)
        expect(getUniqueIdentifierForCucumberSpy).toBeCalledTimes(1)
    })

    afterEach(() => {
        getUniqueIdentifierSpy.mockReset()
        getUniqueIdentifierForCucumberSpy.mockReset()
    })
})
