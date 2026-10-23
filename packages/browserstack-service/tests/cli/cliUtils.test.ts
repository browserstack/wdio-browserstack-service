import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { ZipFile } from 'yauzl'
import yauzl from 'yauzl'
import os from 'node:os'
import * as cliLogger from '../../src/cli/cliLogger.js'
import * as utilModule from '../../src/util.js'

import { CLIUtils } from '../../src/cli/cliUtils.js'
import PerformanceTester from '../../src/instrumentation/performance/performance-tester.js'
import { EVENTS as PerformanceEvents } from '../../src/instrumentation/performance/constants.js'
import type { Options } from '@wdio/types'
import type { BrowserstackConfig, BrowserstackOptions } from '../../src/types.js'
import APIUtils from '../../src/cli/apiUtils.js'

const cliLoggerSpy = vi.spyOn(cliLogger.BStackLogger, 'logToFile')
cliLoggerSpy.mockImplementation(() => {})

// vi.mock('../../src/util.js', () => ({
//     isNullOrEmpty: vi.fn()
// }))

describe('CLIUtils', () => {
    beforeEach(() => {
        vi.resetAllMocks()
    })

    afterEach(() => {
        vi.resetAllMocks()
        vi.restoreAllMocks()
    })

    describe('isDevelopmentEnv', () => {
        it('returns true if env is set to development', async () => {
            process.env.BROWSERSTACK_CLI_ENV = 'development'
            expect(CLIUtils.isDevelopmentEnv()).toBe(true)
        })

        it('returns false if env is not set to development', async () => {
            process.env.BROWSERSTACK_CLI_ENV = 'production'
            expect(CLIUtils.isDevelopmentEnv()).toBe(false)
        })
    })

    describe('getCLIParamsForDevEnv', () => {
        it('returns correct CLI params with environment variable set', () => {
            process.env.BROWSERSTACK_CLI_ENV = 'test'
            const params = CLIUtils.getCLIParamsForDevEnv()
            expect(params).toEqual({
                id: 'test',
                listen: 'unix:/tmp/sdk-platform-test.sock'
            })
        })

        it('returns CLI params with empty id when env not set', () => {
            delete process.env.BROWSERSTACK_CLI_ENV
            const params = CLIUtils.getCLIParamsForDevEnv()
            expect(params).toEqual({
                id: '',
                listen: 'unix:/tmp/sdk-platform-undefined.sock'
            })
        })
    })

    describe('getBinConfig', () => {
        const mockConfig = {
            user: 'testuser',
            key: 'testkey',
            capabilities: {
                'bstack:options': {
                    buildName: 'common-build'
                }
            } as Record <string, unknown>
        } as Options.Testrunner
        const createBrowserstackOptions = (overrides: Record<string, unknown> = {}) => overrides as unknown as BrowserstackConfig & BrowserstackOptions

        it('returns stringified config with basic options', () => {
            const capabilities = [
                { browserName: 'chrome' }
            ]
            const options = createBrowserstackOptions()

            const result = CLIUtils.getBinConfig(mockConfig, capabilities, options)
            const parsed = JSON.parse(result)

            expect(parsed).toEqual({
                userName: 'testuser',
                accessKey: 'testkey',
                buildName: 'common-build',
                buildTag: [],
                isNonBstackA11yWDIO: true,
                testContextOptions: {
                    skipSessionName: false,
                    skipSessionStatus: false,
                    sessionNameOmitTestTitle: false,
                    sessionNamePrependTopLevelSuiteTitle: false,
                    sessionNameFormat: ''
                },
                platforms: [{
                    browserName: 'chrome'
                }]
            })
        })

        it('handles array of capabilities', () => {
            const capabilities = [
                { browserName: 'chrome' },
                { browserName: 'firefox' }
            ]
            const options = createBrowserstackOptions()

            const result = CLIUtils.getBinConfig(mockConfig, capabilities, options)
            const parsed = JSON.parse(result)

            expect(parsed.platforms).toHaveLength(2)
            expect(parsed.platforms).toEqual([
                { browserName: 'chrome' },
                { browserName: 'firefox' }
            ])
        })

        it('processes bstack:options in capabilities', () => {
            const capabilities = [{
                browserName: 'chrome',
                'bstack:options': {
                    os: 'Windows',
                    osVersion: '10'
                }
            }]
            const options = createBrowserstackOptions()

            const result = CLIUtils.getBinConfig(mockConfig, capabilities, options)
            const parsed = JSON.parse(result)

            expect(parsed.platforms[0]).toEqual({
                browserName: 'chrome',
                os: 'Windows',
                osVersion: '10'
            })
        })

        it('converts opts to browserstackLocalOptions in options', () => {
            const capabilities = [
                { browserName: 'chrome' }
            ]
            const options = createBrowserstackOptions({
                opts: {
                    localIdentifier: 'test123'
                }
            })

            const result = CLIUtils.getBinConfig(mockConfig, capabilities, options)
            const parsed = JSON.parse(result)

            expect(parsed.browserStackLocalOptions).toEqual({
                localIdentifier: 'test123'
            })
            expect(parsed.opts).toBeUndefined()
        })

        it('prioritizes options over capability values', () => {
            const capabilities = [{
                browserName: 'chrome',
                'bstack:options': {
                    buildName: 'cap-build'
                }
            }]
            const options = createBrowserstackOptions({
                buildName: 'opt-build'
            })

            const result = CLIUtils.getBinConfig(mockConfig, capabilities, options)
            const parsed = JSON.parse(result)

            expect(parsed.buildName).toBe('common-build')
            expect(parsed.platforms[0]).not.toHaveProperty('buildName')
        })

        it('includes testManagementOptions when testPlanId is provided', () => {
            const capabilities = [
                { browserName: 'chrome' }
            ]
            const options = createBrowserstackOptions({
                testManagementOptions: {
                    testPlanId: 'tm-plan-123'
                }
            })

            const result = CLIUtils.getBinConfig(mockConfig, capabilities, options)
            const parsed = JSON.parse(result)

            expect(parsed.testManagementOptions).toEqual({
                testPlanId: 'tm-plan-123'
            })
        })

        it('drops a blank testPlanId and keeps the other testManagementOptions keys', () => {
            const capabilities = [
                { browserName: 'chrome' }
            ]
            const emptyPlanOptions = createBrowserstackOptions({
                testManagementOptions: {
                    testPlanId: '   ',
                    ignoredKey: 'ignored'
                }
            })
            const validPlanOptions = createBrowserstackOptions({
                testManagementOptions: {
                    testPlanId: ' tm-plan-456 ',
                    ignoredKey: 'ignored'
                }
            })

            const emptyPlanResult = CLIUtils.getBinConfig(mockConfig, capabilities, emptyPlanOptions)

            const emptyPlanParsed = JSON.parse(emptyPlanResult)
            expect(emptyPlanParsed.testManagementOptions).toEqual({
                ignoredKey: 'ignored'
            })

            const validPlanResult = CLIUtils.getBinConfig(mockConfig, capabilities, validPlanOptions)

            const validPlanParsed = JSON.parse(validPlanResult)
            expect(validPlanParsed.testManagementOptions).toEqual({
                testPlanId: 'tm-plan-456',
                ignoredKey: 'ignored'
            })
        })
    })

    describe('applyServerSdkConfig', () => {
        it('applies exactly the listed keys and leaves echoes alone', () => {
            const options: Record<string, unknown> = { parallelsPerPlatform: 1, buildName: 'local', testObservability: true }
            const applied = CLIUtils.applyServerSdkConfig(options, { parallelsPerPlatform: 3, buildName: 'server-echo', testObservability: false }, ['parallelsPerPlatform'])
            expect(applied).toEqual(['parallelsPerPlatform'])
            expect(options).toEqual({ parallelsPerPlatform: 3, buildName: 'local', testObservability: true })
        })

        it('deep-merges objects, merges arrays element-wise and lets null replace', () => {
            const options: Record<string, unknown> = {
                accessibilityOptions: { wcagVersion: 'wcag21aa', includeIssueType: { bestPractice: true } },
                testObservabilityOptions: { buildTag: ['a', 'b'] },
                percyOptions: { version: 'v2' },
            }
            CLIUtils.applyServerSdkConfig(options, {
                accessibilityOptions: { wcagVersion: 'wcag2a' },
                testObservabilityOptions: { buildTag: ['x'] },
                percyOptions: null,
            }, ['accessibilityOptions', 'testObservabilityOptions', 'percyOptions'])
            expect(options).toEqual({
                accessibilityOptions: { wcagVersion: 'wcag2a', includeIssueType: { bestPractice: true } },
                testObservabilityOptions: { buildTag: ['x', 'b'] },
                percyOptions: null,
            })
        })

        it('maps the keys getBinConfig renamed back to the service options', () => {
            const options: Record<string, unknown> = { opts: { forceLocal: true }, setSessionName: true, setSessionStatus: true, sessionNameFormat: '' }
            const sent = JSON.parse(CLIUtils.getBinConfig({ user: 'u', key: 'k' } as Options.Testrunner, [{ browserName: 'chrome' }], options as BrowserstackConfig & BrowserstackOptions))
            expect(sent.browserStackLocalOptions).toEqual({ forceLocal: true })
            expect(sent.testContextOptions.skipSessionName).toBe(false)

            const applied = CLIUtils.applyServerSdkConfig(options, {
                browserStackLocalOptions: { localIdentifier: 'srv-id' },
                testContextOptions: { skipSessionName: true, sessionNameFormat: '{testTitle}' },
            }, ['browserStackLocalOptions', 'testContextOptions'])
            expect(applied).toEqual(['browserStackLocalOptions', 'testContextOptions'])
            expect(options).toEqual({ opts: { forceLocal: true, localIdentifier: 'srv-id' }, setSessionName: false, setSessionStatus: true, sessionNameFormat: '' })
        })

        it('reports platforms as applied without storing them as an option', () => {
            const options: Record<string, unknown> = {}
            expect(CLIUtils.applyServerSdkConfig(options, { platforms: [{ browserVersion: 'latest-1' }] }, ['platforms'])).toEqual(['platforms'])
            expect(options).toEqual({})
        })

        it('skips listed keys the server config does not carry, non-string keys and unsafe keys', () => {
            const options: Record<string, unknown> = { debug: false }
            const server = JSON.parse('{"__proto__":{"polluted":true},"debug":true}')
            expect(CLIUtils.applyServerSdkConfig(options, server, ['missing', 7, '__proto__', 'debug'])).toEqual(['debug'])
            expect(options).toEqual({ debug: true })
            expect(({} as Record<string, unknown>).polluted).toBeUndefined()
        })

        it('does not share objects with the server config', () => {
            const server = { accessibilityOptions: { wcagVersion: 'wcag2a' } }
            const options: Record<string, unknown> = {}
            CLIUtils.applyServerSdkConfig(options, server, ['accessibilityOptions'])
            ;(options.accessibilityOptions as Record<string, unknown>).wcagVersion = 'changed'
            expect(server.accessibilityOptions.wcagVersion).toBe('wcag2a')
        })
    })

    describe('assignSafeKeys', () => {
        it('copies every key except prototype keys', () => {
            const target: Record<string, unknown> = { a: 1 }
            const source = JSON.parse('{"b":2,"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":{"y":1}}')
            CLIUtils.assignSafeKeys(target, source)
            expect(target).toEqual({ a: 1, b: 2 })
            expect(({} as Record<string, unknown>).polluted).toBeUndefined()
        })
    })

    describe('applyServerPlatform', () => {
        it('puts flattened bstack:options keys back under bstack:options and keeps top-level keys on top', () => {
            const capability: Record<string, unknown> = {
                browserName: 'chrome',
                browserVersion: 'latest',
                'goog:chromeOptions': { args: ['--headless'] },
                'bstack:options': { os: 'Windows', osVersion: '11', buildName: 'local' },
            }
            CLIUtils.applyServerPlatform(capability, {
                browserVersion: 'latest-1',
                osVersion: '10',
                'goog:chromeOptions': { args: ['--incognito'] },
                seleniumVersion: '4.21.0',
                'ms:edgeOptions': { args: [] },
            })
            expect(capability).toEqual({
                browserName: 'chrome',
                browserVersion: 'latest-1',
                'goog:chromeOptions': { args: ['--incognito'] },
                'ms:edgeOptions': { args: [] },
                'bstack:options': { os: 'Windows', osVersion: '10', buildName: 'local', seleniumVersion: '4.21.0' },
            })
        })

        it('keeps every key at the top level of a capability without bstack:options', () => {
            const capability: Record<string, unknown> = { browserName: 'chrome' }
            CLIUtils.applyServerPlatform(capability, { browserVersion: 'latest-1' })
            expect(capability).toEqual({ browserName: 'chrome', browserVersion: 'latest-1' })
        })

        it('ignores a non-object platform', () => {
            const capability: Record<string, unknown> = { browserName: 'chrome' }
            CLIUtils.applyServerPlatform(capability, undefined)
            CLIUtils.applyServerPlatform(capability, ['x'])
            expect(capability).toEqual({ browserName: 'chrome' })
        })

        it('keeps routing into bstack:options after the entry merges a bstack:options key', () => {
            const capability: Record<string, unknown> = { browserName: 'chrome', 'bstack:options': { os: 'Windows', osVersion: '11' } }
            CLIUtils.applyServerPlatform(capability, { 'bstack:options': { debug: true }, osVersion: '10' })
            expect(capability['bstack:options']).toEqual({ os: 'Windows', osVersion: '10', debug: true })
        })

        it('does not write into a bstack:options object shared with another capability', () => {
            const shared = { os: 'Windows', osVersion: '11' }
            const first: Record<string, unknown> = { browserName: 'chrome', 'bstack:options': shared }
            const second: Record<string, unknown> = { browserName: 'edge', 'bstack:options': shared }
            CLIUtils.applyServerPlatform(first, { osVersion: '10' })
            expect(first['bstack:options']).toEqual({ os: 'Windows', osVersion: '10' })
            expect(second['bstack:options']).toEqual({ os: 'Windows', osVersion: '11' })
        })

        it('does not share objects with the server platform entry', () => {
            const capability: Record<string, unknown> = { browserName: 'chrome' }
            const platform = { 'goog:chromeOptions': { args: ['--incognito'] } }
            CLIUtils.applyServerPlatform(capability, platform)
            platform['goog:chromeOptions'].args.push('--mutated')
            expect(capability['goog:chromeOptions']).toEqual({ args: ['--incognito'] })
        })

        it('updates bstack:options when the capability holds the key at both levels', () => {
            const capability: Record<string, unknown> = {
                browserName: 'chrome',
                browserVersion: 'latest',
                'bstack:options': { browserVersion: 'latest' }
            }
            CLIUtils.applyServerPlatform(capability, { browserVersion: 'latest-1' })
            expect(capability).toEqual({
                browserName: 'chrome',
                browserVersion: 'latest',
                'bstack:options': { browserVersion: 'latest-1' }
            })
        })

        it('maps a key getBinConfig left out of the platform because it is also a top-level option back to bstack:options', () => {
            const capability: Record<string, unknown> = { browserName: 'chrome', 'bstack:options': { os: 'Windows', buildName: 'cap-build' } }
            const sent = JSON.parse(CLIUtils.getBinConfig({ user: 'u', key: 'k' } as Options.Testrunner, [capability], { buildName: 'top-build' } as BrowserstackConfig & BrowserstackOptions))
            expect(sent.platforms[0]).toEqual({ browserName: 'chrome', os: 'Windows' })

            CLIUtils.applyServerPlatform(capability, { buildName: 'srv-build' })
            expect(capability).toEqual({ browserName: 'chrome', 'bstack:options': { os: 'Windows', buildName: 'srv-build' } })
        })
    })

    describe('getSdkVersion', () => {
        it('returns the bstack service version', () => {
            const version = CLIUtils.getSdkVersion()
            expect(typeof version).toBe('string')
        })
    })

    describe('getSdkLanguage', () => {
        it('returns ECMAScript as sdk language', () => {
            expect(CLIUtils.getSdkLanguage()).toBe('ECMAScript')
        })
    })

    describe('getExistingCliPath', () => {
        const mockCliDir = '/mock/cli/dir'

        beforeEach(() => {
            vi.resetAllMocks()
            vi.spyOn(fs, 'existsSync').mockReturnValue(true)
            vi.spyOn(fs, 'statSync').mockReturnValue({
                isDirectory: () => true,
                isFile: () => true,
                mtime: new Date()
            } as fs.Stats)
            vi.spyOn(fs, 'readdirSync').mockReturnValue([])
            vi.spyOn(path, 'basename').mockImplementation((p) => p)
        })

        it('returns empty string when directory does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false)

            const result = CLIUtils.getExistingCliPath(mockCliDir)
            expect(result).toBe('')
        })

        it('returns empty string when path is not a directory', () => {
            vi.mocked(fs.statSync).mockReturnValue({
                isDirectory: () => false,
                isFile: () => true,
                mtime: new Date()
            } as fs.Stats)

            const result = CLIUtils.getExistingCliPath(mockCliDir)
            expect(result).toBe('')
        })

        it('returns empty string when no binary files found', () => {
            vi.mocked(fs.readdirSync).mockReturnValue([
                'other-file.txt'
            ] as any)

            const result = CLIUtils.getExistingCliPath(mockCliDir)
            expect(result).toBe('')
        })

        it('handles filesystem errors', () => {
            vi.mocked(fs.readdirSync).mockImplementation(() => {
                throw new Error('Mock filesystem error')
            })

            const result = CLIUtils.getExistingCliPath(mockCliDir)
            expect(result).toBe('')
        })
    })

    describe('getTestFrameworkDetail', () => {
        beforeEach(() => {
            // Reset class property and env variable before each test
            CLIUtils.testFrameworkDetail = {}
            delete process.env.BROWSERSTACK_TEST_FRAMEWORK_DETAIL
        })

        it('returns parsed value from environment variable when set', () => {
            const mockFramework = {
                name: 'mocha',
                version: { mocha: '8.0.0' }
            }
            process.env.BROWSERSTACK_TEST_FRAMEWORK_DETAIL = JSON.stringify(mockFramework)

            const result = CLIUtils.getTestFrameworkDetail()
            expect(result).toEqual(mockFramework)
        })

        it('returns class property when environment variable is not set', () => {
            const mockFramework = {
                name: 'jest',
                version: { jest: 'latest' }
            }
            CLIUtils.testFrameworkDetail = mockFramework

            const result = CLIUtils.getTestFrameworkDetail()
            expect(result).toEqual(mockFramework)
        })
    })

    describe('getAutomationFrameworkDetail', () => {
        beforeEach(() => {
            // Reset class property and env variable before each test
            CLIUtils.automationFrameworkDetail = {}
            delete process.env.BROWSERSTACK_AUTOMATION_FRAMEWORK_DETAIL
        })

        it('returns parsed value from environment variable when set', () => {
            const mockFramework = {
                name: 'webdriver',
                version: 'latest'
            }
            process.env.BROWSERSTACK_AUTOMATION_FRAMEWORK_DETAIL = JSON.stringify(mockFramework)

            const result = CLIUtils.getAutomationFrameworkDetail()
            expect(result).toEqual(mockFramework)
        })

        it('returns class property when environment variable is not set', () => {
            const mockFramework = {
                name: 'selenium',
                version: '4.0.0'
            }
            CLIUtils.automationFrameworkDetail = mockFramework

            const result = CLIUtils.getAutomationFrameworkDetail()
            expect(result).toEqual(mockFramework)
        })
    })

    describe('setFrameworkDetail', () => {
        it('sets framework details correctly', () => {
            CLIUtils.setFrameworkDetail('mocha', 'webdriver')

            expect(process.env.BROWSERSTACK_TEST_FRAMEWORK_DETAIL).toBeDefined()
            expect(process.env.BROWSERSTACK_AUTOMATION_FRAMEWORK_DETAIL).toBeDefined()

            const testFramework = JSON.parse(process.env.BROWSERSTACK_TEST_FRAMEWORK_DETAIL!)
            const autoFramework = JSON.parse(process.env.BROWSERSTACK_AUTOMATION_FRAMEWORK_DETAIL!)

            expect(testFramework).toEqual({
                name: 'mocha',
                version: { mocha: CLIUtils.getSdkVersion() }
            })
            expect(autoFramework).toEqual({
                name: 'webdriver',
                version: { webdriver: CLIUtils.getSdkVersion() }
            })
        })
    })

    describe('checkAndUpdateCli', () => {
        const mockConfig = {} as Options.Testrunner
        const mockCliDir = '/mock/cli/dir'
        const mockExistingPath = '/mock/cli/dir/binary-1.0.0'

        beforeEach(() => {
            // Reset mocks and spies
            vi.resetAllMocks()

            // Mock platform and arch
            vi.spyOn(os, 'platform').mockReturnValue('darwin')
            vi.spyOn(os, 'arch').mockReturnValue('x64')

            // Mock SDK version and language
            vi.spyOn(CLIUtils, 'getSdkVersion').mockReturnValue('1.0.0')
            vi.spyOn(CLIUtils, 'getSdkLanguage').mockReturnValue('wdio')

            // Mock performance tester
            vi.spyOn(PerformanceTester, 'start').mockImplementation(() => {})
            vi.spyOn(PerformanceTester, 'end').mockImplementation(() => {})
        })

        afterEach(() => {
            vi.restoreAllMocks()
        })

        it('returns existing path when no update is needed', async () => {
            // Mock shell command and API response
            vi.spyOn(CLIUtils, 'runShellCommand').mockResolvedValue('1.0.0')
            vi.spyOn(CLIUtils, 'requestToUpdateCLI').mockResolvedValue({})

            const result = await CLIUtils.checkAndUpdateCli(mockExistingPath, mockCliDir, mockConfig)

            expect(result).toBe(mockExistingPath)
            expect(PerformanceTester.start).toHaveBeenCalledWith(PerformanceEvents.SDK_CLI_CHECK_UPDATE)
            expect(PerformanceTester.end).toHaveBeenCalledWith(PerformanceEvents.SDK_CLI_CHECK_UPDATE)
        })

        it('downloads and returns new binary path when update is available', async () => {
            const mockNewBinaryPath = '/mock/cli/dir/binary-2.0.0'
            const mockResponse = {
                updated_cli_version: '2.0.0',
                url: 'https://example.com/binary-2.0.0'
            }

            // Mock required methods
            vi.spyOn(CLIUtils, 'runShellCommand').mockResolvedValue('1.0.0')
            vi.spyOn(CLIUtils, 'requestToUpdateCLI').mockResolvedValue(mockResponse)
            vi.spyOn(CLIUtils, 'downloadLatestBinary').mockResolvedValue(mockNewBinaryPath)

            const result = await CLIUtils.checkAndUpdateCli(mockExistingPath, mockCliDir, mockConfig)

            expect(result).toBe(mockNewBinaryPath)
            expect(CLIUtils.downloadLatestBinary).toHaveBeenCalledWith(mockResponse.url, mockCliDir)
        })

        it('uses default cli_version when existing path is empty', async () => {
            vi.spyOn(CLIUtils, 'runShellCommand').mockResolvedValue('SHELL_EXECUTE_ERROR')
            vi.spyOn(CLIUtils, 'requestToUpdateCLI').mockResolvedValue({})

            const result = await CLIUtils.checkAndUpdateCli(mockExistingPath, mockCliDir, mockConfig)

            expect(result).toBe(mockExistingPath)
            expect(CLIUtils.runShellCommand).toHaveBeenCalled()
            expect(CLIUtils.requestToUpdateCLI).toHaveBeenCalledWith(
                expect.objectContaining({ cli_version: 'SHELL_EXECUTE_ERROR' }),
                mockConfig
            )
        })

        it('falls back to BROWSERSTACK_BINARY_URL when update_cli fails (SDK-6948)', async () => {
            const saved = process.env.BROWSERSTACK_BINARY_URL
            process.env.BROWSERSTACK_BINARY_URL = 'https://example.com/staging-binary.zip'
            try {
                const fallbackPath = '/mock/cli/dir/binary-fallback'
                vi.spyOn(CLIUtils, 'runShellCommand').mockResolvedValue('1.0.0')
                // update_cli fails (e.g. staging creds against the prod api host -> 401)
                vi.spyOn(CLIUtils, 'requestToUpdateCLI').mockRejectedValue({ response: { statusCode: 401 } })
                vi.spyOn(CLIUtils, 'downloadLatestBinary').mockResolvedValue(fallbackPath)

                const result = await CLIUtils.checkAndUpdateCli(mockExistingPath, mockCliDir, mockConfig)

                expect(result).toBe(fallbackPath)
                expect(CLIUtils.downloadLatestBinary).toHaveBeenCalledWith('https://example.com/staging-binary.zip', mockCliDir)
            } finally {
                if (saved === undefined) { delete process.env.BROWSERSTACK_BINARY_URL } else { process.env.BROWSERSTACK_BINARY_URL = saved }
            }
        })

        it('uses the cached binary when the BROWSERSTACK_BINARY_URL download fails (SDK-6948)', async () => {
            const saved = process.env.BROWSERSTACK_BINARY_URL
            process.env.BROWSERSTACK_BINARY_URL = 'https://example.com/staging-binary.zip'
            try {
                vi.spyOn(CLIUtils, 'runShellCommand').mockResolvedValue('1.0.0')
                vi.spyOn(CLIUtils, 'requestToUpdateCLI').mockRejectedValue({ response: { statusCode: 401 } })
                vi.spyOn(CLIUtils, 'downloadLatestBinary').mockRejectedValue(new Error('download failed'))

                const result = await CLIUtils.checkAndUpdateCli(mockExistingPath, mockCliDir, mockConfig)

                expect(result).toBe(mockExistingPath)
            } finally {
                if (saved === undefined) { delete process.env.BROWSERSTACK_BINARY_URL } else { process.env.BROWSERSTACK_BINARY_URL = saved }
            }
        })

        it('re-throws the download error when the BROWSERSTACK_BINARY_URL download fails and no binary is cached (SDK-6948)', async () => {
            const saved = process.env.BROWSERSTACK_BINARY_URL
            process.env.BROWSERSTACK_BINARY_URL = 'https://example.com/staging-binary.zip'
            try {
                const downloadErr = new Error('download failed')
                vi.spyOn(CLIUtils, 'requestToUpdateCLI').mockRejectedValue({ response: { statusCode: 401 } })
                vi.spyOn(CLIUtils, 'downloadLatestBinary').mockRejectedValue(downloadErr)

                await expect(CLIUtils.checkAndUpdateCli('', mockCliDir, mockConfig)).rejects.toBe(downloadErr)
            } finally {
                if (saved === undefined) { delete process.env.BROWSERSTACK_BINARY_URL } else { process.env.BROWSERSTACK_BINARY_URL = saved }
            }
        })

        it('falls back to BROWSERSTACK_BINARY_URL when a 2xx reply has neither url nor updated_cli_version and no binary is cached (SDK-6948)', async () => {
            const saved = process.env.BROWSERSTACK_BINARY_URL
            process.env.BROWSERSTACK_BINARY_URL = 'https://example.com/staging-binary.zip'
            try {
                vi.spyOn(CLIUtils, 'requestToUpdateCLI').mockResolvedValue({ message: 'Unauthorized' })
                vi.spyOn(CLIUtils, 'downloadLatestBinary').mockResolvedValue('/mock/cli/dir/binary-fallback')

                const result = await CLIUtils.checkAndUpdateCli('', mockCliDir, mockConfig)

                expect(result).toBe('/mock/cli/dir/binary-fallback')
                expect(CLIUtils.downloadLatestBinary).toHaveBeenCalledWith('https://example.com/staging-binary.zip', mockCliDir)
            } finally {
                if (saved === undefined) { delete process.env.BROWSERSTACK_BINARY_URL } else { process.env.BROWSERSTACK_BINARY_URL = saved }
            }
        })

        it('keeps the cached binary when a 2xx reply has neither url nor updated_cli_version (SDK-6948)', async () => {
            const saved = process.env.BROWSERSTACK_BINARY_URL
            process.env.BROWSERSTACK_BINARY_URL = 'https://example.com/staging-binary.zip'
            try {
                vi.spyOn(CLIUtils, 'runShellCommand').mockResolvedValue('1.0.0')
                vi.spyOn(CLIUtils, 'requestToUpdateCLI').mockResolvedValue({ success: true })
                const downloadSpy = vi.spyOn(CLIUtils, 'downloadLatestBinary').mockResolvedValue('/should/not/be/used')

                const result = await CLIUtils.checkAndUpdateCli(mockExistingPath, mockCliDir, mockConfig)

                expect(result).toBe(mockExistingPath)
                expect(downloadSpy).not.toHaveBeenCalled()
            } finally {
                if (saved === undefined) { delete process.env.BROWSERSTACK_BINARY_URL } else { process.env.BROWSERSTACK_BINARY_URL = saved }
            }
        })

        it('re-throws when update_cli fails and no BROWSERSTACK_BINARY_URL is set (unchanged behaviour)', async () => {
            const saved = process.env.BROWSERSTACK_BINARY_URL
            delete process.env.BROWSERSTACK_BINARY_URL
            try {
                const err = new Error('Unauthorized')
                vi.spyOn(CLIUtils, 'runShellCommand').mockResolvedValue('1.0.0')
                vi.spyOn(CLIUtils, 'requestToUpdateCLI').mockRejectedValue(err)
                const downloadSpy = vi.spyOn(CLIUtils, 'downloadLatestBinary').mockResolvedValue('/should/not/be/used')

                await expect(CLIUtils.checkAndUpdateCli(mockExistingPath, mockCliDir, mockConfig)).rejects.toBe(err)
                expect(downloadSpy).not.toHaveBeenCalled()
            } finally {
                if (saved !== undefined) { process.env.BROWSERSTACK_BINARY_URL = saved }
            }
        })
    })

    describe('setupCliPath', () => {
        const mockConfig = {} as Options.Testrunner

        beforeEach(() => {
            // Reset environment variables and mocks
            delete process.env.SDK_CLI_BIN_PATH
            vi.resetAllMocks()
        })

        afterEach(() => {
            vi.restoreAllMocks()
        })

        it('returns development binary path when SDK_CLI_BIN_PATH is set', async () => {
            process.env.SDK_CLI_BIN_PATH = '/custom/path/to/binary'
            const result = await CLIUtils.setupCliPath(mockConfig)
            expect(result).toBe('/custom/path/to/binary')
        })

        it('returns null when getCliDir returns empty string', async () => {
            vi.spyOn(CLIUtils, 'getCliDir').mockReturnValue('')
            const result = await CLIUtils.setupCliPath(mockConfig)
            expect(result).toBeNull()
        })

        it('returns final binary path when setup is successful', async () => {
            const mockCliDir = '/mock/cli/dir'
            const mockExistingPath = '/mock/cli/dir/binary-1.0.0'
            const mockFinalPath = '/mock/cli/dir/binary-2.0.0'

            vi.spyOn(CLIUtils, 'getCliDir').mockReturnValue(mockCliDir)
            vi.spyOn(CLIUtils, 'getExistingCliPath').mockReturnValue(mockExistingPath)
            vi.spyOn(CLIUtils, 'checkAndUpdateCli').mockResolvedValue(mockFinalPath)

            const result = await CLIUtils.setupCliPath(mockConfig)
            expect(result).toBe(mockFinalPath)
        })

        it('returns null when an error occurs during setup', async () => {
            vi.spyOn(CLIUtils, 'getCliDir').mockImplementation(() => {
                throw new Error('Mock error')
            })

            const result = await CLIUtils.setupCliPath(mockConfig)
            expect(result).toBeNull()
        })
    })

    describe('getCurrentInstanceName', () => {
        it('returns string with process id and thread id', () => {
            const instanceName = CLIUtils.getCurrentInstanceName()
            expect(instanceName).toMatch(/^\d+:\d+$/)
        })
    })

    describe('requestToUpdateCLI', () => {
        const mockConfig = {
            user: 'testuser',
            key: 'testkey'
        } as Options.Testrunner
        let nodeRequestSpy: ReturnType<typeof vi.spyOn>
        let getBrowserStackUserSpy: ReturnType<typeof vi.spyOn>
        let getBrowserStackKeySpy: ReturnType<typeof vi.spyOn>

        beforeEach(() => {
            vi.resetAllMocks()
            nodeRequestSpy = vi.spyOn(utilModule, 'nodeRequest').mockResolvedValue({ status: 'success' } as any)
            getBrowserStackUserSpy = vi.spyOn(utilModule, 'getBrowserStackUser').mockReturnValue('testuser')
            getBrowserStackKeySpy = vi.spyOn(utilModule, 'getBrowserStackKey').mockReturnValue('testkey')
        })

        afterEach(() => {
            vi.clearAllMocks()
        })

        it('constructs correct URL with query parameters', async () => {
            const queryParams = {
                param1: 'value1',
                param2: 'value2'
            }

            nodeRequestSpy.mockResolvedValue({} as any)

            await CLIUtils.requestToUpdateCLI(queryParams, mockConfig)

            expect(nodeRequestSpy).toHaveBeenCalledWith(
                'GET',
                expect.stringContaining('param1=value1'),
                expect.any(Object),
                APIUtils.BROWSERSTACK_AUTOMATE_API_URL
            )
            expect(nodeRequestSpy).toHaveBeenCalledWith(
                'GET',
                expect.stringContaining('param2=value2'),
                expect.any(Object),
                APIUtils.BROWSERSTACK_AUTOMATE_API_URL
            )
            expect(getBrowserStackUserSpy).toHaveBeenCalledWith(mockConfig)
            expect(getBrowserStackKeySpy).toHaveBeenCalledWith(mockConfig)
        })

        it('returns response from nodeRequest', async () => {
            const mockResponse = { updated_cli_version: '2.0.0' }
            nodeRequestSpy.mockResolvedValue(mockResponse as any)

            const result = await CLIUtils.requestToUpdateCLI({}, mockConfig)

            expect(result).toEqual(mockResponse)
        })

        it('handles errors from nodeRequest', async () => {
            const mockError = new Error('Network error')
            nodeRequestSpy.mockRejectedValue(mockError)

            await expect(CLIUtils.requestToUpdateCLI({}, mockConfig))
                .rejects
                .toThrow('Network error')
        })
    })

    describe('runShellCommand', () => {
        it('resolves with stdout for successful command', async () => {
            const result = await CLIUtils.runShellCommand('echo test')
            expect(result).toBe('test')
        })
    })

    describe('downloadFileStream', () => {
        const mockCliDir = '/mock/cli/dir'
        const mockZipFilePath = path.join(mockCliDir, 'downloaded_file.zip')
        let mockWriteStream: fs.WriteStream
        let mockZipFile: ZipFile

        beforeEach(() => {
            vi.resetAllMocks()
            mockWriteStream = {
                on: vi.fn()
            } as unknown as fs.WriteStream

            mockZipFile = {
                readEntry: vi.fn(),
                on: vi.fn(),
                once: vi.fn(),
                close: vi.fn()
            } as unknown as ZipFile

            vi.spyOn(yauzl, 'open').mockImplementation((filePath: string, callback: (err: Error | null, zipfile: ZipFile | null) => void) => {
                callback(null, mockZipFile)
            })
        })

        it('handles zip file errors', async () => {
            const resolve = vi.fn()
            const reject = vi.fn()
            let closeCallback: () => Promise<void> = async () => {}

            vi.spyOn(yauzl, 'open').mockImplementation((filePath: string, callback: (err: Error | null, zipfile: ZipFile | null) => void) => {
                callback(new Error('Zip error'), null)
            })

            mockWriteStream.on = vi.fn().mockImplementation((event, callback) => {
                if (event === 'close') {
                    closeCallback = callback
                }
            })

            CLIUtils.downloadFileStream(
                mockWriteStream,
                'binary-1.0.0',
                mockZipFilePath,
                mockCliDir,
                resolve,
                reject
            )

            await closeCallback()
            expect(reject).toHaveBeenCalled()
        })
    })

    describe('getCliDir', () => {
        it('returns empty string when writable directory is not available', () => {
            vi.spyOn(CLIUtils, 'getWritableDir').mockReturnValue(null)
            expect(CLIUtils.getCliDir()).toBe('')
        })
    })
})
