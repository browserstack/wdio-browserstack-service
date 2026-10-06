import path from 'node:path'

import { describe, expect, it, vi, beforeEach } from 'vitest'

import BrowserstackService from '../src/service.js'
import { reportSuiteFailed, reportSuiteSkipped } from '../src/cli/skipReporter.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import * as utils from '../src/util.js'

vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))

vi.mock('../src/cli/skipReporter.js', () => ({
    drainSkipReports: vi.fn().mockResolvedValue(undefined),
    markTestStarted: vi.fn(),
    reportSuiteSkipped: vi.fn().mockResolvedValue(undefined),
    reportSuiteFailed: vi.fn().mockResolvedValue(undefined),
    reportSkippedTest: vi.fn().mockResolvedValue(undefined),
    resolveSpecFile: vi.fn()
}))

vi.mock('../src/instrumentation/performance/performance-tester.js', () => ({
    default: {
        start: vi.fn(),
        end: vi.fn(),
        startMonitoring: vi.fn(),
        stopAndGenerate: vi.fn().mockResolvedValue(undefined),
        calculateTimes: vi.fn(),
        measureWrapper: vi.fn().mockImplementation((_name: string, fn: Function) => fn),
        Measure: vi.fn().mockImplementation(() => (_t: any, _k: string, d: PropertyDescriptor) => d)
    }
}))

vi.mock('../src/cli/index.js', () => ({
    BrowserstackCLI: {
        getInstance: vi.fn()
    }
}))

/**
 * Mocha 12 (WebdriverIO 10) fails the tests that a failed before/beforeEach hook skipped.
 * The service must report them with the same status, on the CLI and the legacy path.
 */
describe('afterHook — tests affected by a failed hook', () => {
    const suite = { title: 'suite', tests: [], suites: [] }
    const hookTest = { title: '"before all" hook for "logs in"', parent: 'suite', ctx: { test: { parent: suite } } } as any
    const failedResult = { passed: false, error: new Error('login failed') } as any
    const framework = { trackEvent: vi.fn().mockResolvedValue(undefined) }

    const makeService = (mochaOpts?: Record<string, unknown>) =>
        new BrowserstackService({} as any, [] as any, { user: 'foo', key: 'bar', framework: 'mocha', mochaOpts } as any)

    const cliRunning = (running: boolean) => {
        vi.mocked(BrowserstackCLI.getInstance).mockReturnValue({
            isRunning: () => running,
            getTestFramework: () => framework
        } as never)
    }

    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(utils, 'getWdioMajorVersion').mockReturnValue(10)
    })

    it('reports them as failed with the hook error on the CLI path', async () => {
        cliRunning(true)
        await makeService().afterHook(hookTest, undefined, failedResult)

        expect(reportSuiteSkipped).not.toHaveBeenCalled()
        expect(reportSuiteFailed).toHaveBeenCalledWith(framework, suite, expect.any(Error))
        const error = vi.mocked(reportSuiteFailed).mock.calls[0][2]
        expect(error.message).toBe('Test skipped due to failure in hook ""before all" hook for "logs in"": login failed')
    })

    it('reports them as skipped on the CLI path when the user turned the option off', async () => {
        cliRunning(true)
        await makeService({ failHookAffectedTests: false }).afterHook(hookTest, undefined, failedResult)

        expect(reportSuiteFailed).not.toHaveBeenCalled()
        expect(reportSuiteSkipped).toHaveBeenCalledWith(framework, suite)
    })

    it('reports them as skipped on the CLI path on WebdriverIO 9', async () => {
        vi.spyOn(utils, 'getWdioMajorVersion').mockReturnValue(9)
        cliRunning(true)
        await makeService().afterHook(hookTest, undefined, failedResult)

        expect(reportSuiteFailed).not.toHaveBeenCalled()
        expect(reportSuiteSkipped).toHaveBeenCalledWith(framework, suite)
    })

    it('reports them as skipped on the CLI path after a failed afterEach hook', async () => {
        cliRunning(true)
        const afterEachHook = { ...hookTest, title: '"after each" hook for "logs in"' }
        await makeService().afterHook(afterEachHook, undefined, failedResult)

        expect(reportSuiteFailed).not.toHaveBeenCalled()
        expect(reportSuiteSkipped).toHaveBeenCalledWith(framework, suite)
    })

    it('tells the insights handler to fail them on the legacy path', async () => {
        cliRunning(false)
        const service = makeService()
        const afterHook = vi.fn().mockResolvedValue(undefined)
        service['_insightsHandler'] = { afterHook } as any

        await service.afterHook(hookTest, undefined, failedResult)

        expect(afterHook).toHaveBeenCalledWith(hookTest, failedResult, true)
    })

    it('tells the insights handler to skip them on the legacy path when the user turned the option off', async () => {
        cliRunning(false)
        const service = makeService({ failHookAffectedTests: false })
        const afterHook = vi.fn().mockResolvedValue(undefined)
        service['_insightsHandler'] = { afterHook } as any

        await service.afterHook(hookTest, undefined, failedResult)

        expect(afterHook).toHaveBeenCalledWith(hookTest, failedResult, false)
    })
})
