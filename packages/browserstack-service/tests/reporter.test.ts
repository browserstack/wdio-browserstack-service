import path from 'node:path'
import logger from '@wdio/logger'
import { describe, expect, it, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import type { StdLog } from '../src/index.js'

import TestReporter from '../src/reporter.js'
import * as utils from '../src/util.js'
import * as bstackLogger from '../src/bstackLogger.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import WdioMochaTestFramework from '../src/cli/frameworks/wdioMochaTestFramework.js'
import { TestFrameworkState } from '../src/cli/states/testFrameworkState.js'
import { HookState } from '../src/cli/states/hookState.js'
import { drainSkipReports, reportSkippedTest } from '../src/cli/skipReporter.js'
import TestMetadata from '../src/metadata.js'
import { BROWSERSTACK_CENTRAL_USER } from '../src/constants.js'

const log = logger('test')

// Fake only Date (not setTimeout/setImmediate): this file only needs a deterministic
// clock, and the vi.mock factories below resolve via dynamic import() — bare
// useFakeTimers() freezes the timers that import resolution needs and deadlocks
// collection under Vitest 1.6.x, hanging the file with no output.
vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2020-01-01'))
vi.mock('uuid', () => ({ v4: () => '123456789' }))
vi.mock('@wdio/reporter', () => import(path.join(process.cwd(), '__mocks__', '@wdio/reporter')))
vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))

const bstackLoggerSpy = vi.spyOn(bstackLogger.BStackLogger, 'logToFile')
bstackLoggerSpy.mockImplementation(() => {})

describe('test-reporter', () => {
    const runnerConfig = {
        type: 'runner',
        start: new Date('2018-05-14T15:17:18.901Z'),
        _duration: 0,
        cid: '0-0',
        capabilities: { browserName: 'chrome', browserVersion: '68' }, // session capabilities
        sanitizedCapabilities: 'chrome.66_0_3359_170.linux',
        config: { capabilities: { browserName: 'chrome', browserVersion: '68' }, framework: 'mocha', hostname: 'browserstack.com' }, // user capabilities
        specs: ['/tmp/user/spec.js'],
        sessionId: 'sessionId'
    }

    const testStats = {
        type: 'test',
        start: new Date('2018-05-14T15:17:18.901Z'),
        _duration: 0,
        uid: '23',
        cid: '0-0',
        title: 'Given the title is "Google1"',
        fullTitle: 'TestDesc.TestRun.it',
        output: [],
        argument: undefined,
        retries: 0,
        parent: '1',
        state: 'skipped'
    }

    beforeEach(() => {
        vi.mocked(log.debug).mockClear()
    })

    describe('on create', () => {
        const reporter = new TestReporter({})
        it('should verify initial properties', () => {
            expect(reporter['_capabilities']).toEqual({})
            expect(reporter['_observability']).toBe(true)
            expect(reporter['_sessionId']).toEqual(undefined)
            expect(reporter['_suiteName']).toEqual(undefined)
        })
    })

    describe('onSuiteStart', () => {
        let reporter: TestReporter
        const suite = {
            title: 'suite title',
            file: 'filename',
        }
        beforeEach(() => {
            reporter = new TestReporter({})
            reporter.onSuiteStart(suite as any)
        })

        it('should set _suiteName', () => {
            expect(reporter['_suiteName']).toEqual('filename')
        })

        it ('should store suite in stack', () => {
            expect(reporter['_suites']).toEqual([suite])
            reporter.onSuiteStart(suite as any)
            expect(reporter['_suites']).toEqual([suite, suite])
        })
    })

    describe('onSuiteEnd', function () {
        let reporter: TestReporter
        const suite = {
            title: 'suite title',
            file: 'filename',
        }
        beforeEach(() => {
            reporter = new TestReporter({})
        })

        it('should pop from suites', () => {
            expect(reporter['_suites']).toEqual([])
            reporter.onSuiteStart(suite as any)
            reporter.onSuiteStart(suite as any)
            expect(reporter['_suites']).toEqual([suite, suite])
            reporter.onSuiteEnd()
            expect(reporter['_suites']).toEqual([suite])
            reporter.onSuiteEnd()
            expect(reporter['_suites']).toEqual([])
        })
    })

    describe('onRunnerStart', () => {
        const reporter = new TestReporter({})

        it('should set properties', () => {
            reporter.onRunnerStart(runnerConfig as any)
            expect(reporter['_capabilities']).toEqual({ browserName: 'chrome', browserVersion: '68' })
            expect(reporter['_observability']).toEqual(true)
        })

        it('should set properties - handle false', () => {
            reporter.onRunnerStart({
                type: 'runner',
                start: '2018-05-14T15:17:18.901Z',
                _duration: 0,
                cid: '0-0',
                capabilities: { browserName: 'chrome', browserVersion: '68' }, // session capabilities
                sanitizedCapabilities: 'chrome.66_0_3359_170.linux',
                config: { testObservability: false, capabilities: { browserName: 'chrome', browserVersion: '68' }, framework: 'mocha', hostname: 'browserstack.com' }, // user capabilities
                specs: ['/tmp/user/spec.js'],
                sessionId: 'sessionId'
            } as any)
            expect(reporter['_capabilities']).toEqual({ browserName: 'chrome', browserVersion: '68' })
            expect(reporter['_observability']).toEqual(false)
        })
    })

    describe('onTestSkip', () => {
        const reporter = new TestReporter({})
        const uploadEventDataSpy = vi.spyOn(reporter['listener'], 'testFinished').mockImplementation(() => {})
        const getCloudProviderSpy = vi.spyOn(utils, 'getCloudProvider').mockReturnValue('browserstack')
        let getPlatformVersionSpy: any

        beforeAll(() => {
            getPlatformVersionSpy = vi.spyOn(utils, 'getPlatformVersion').mockImplementation(() => { return 'some version' })
        })

        afterAll(() => {
            getPlatformVersionSpy.mockReset()
        })

        beforeEach(() => {
            uploadEventDataSpy.mockClear()
            getCloudProviderSpy.mockClear()

            reporter.onRunnerStart(runnerConfig as any)
        })

        it('uploadEventData called', async () => {
            reporter['_observability'] = true
            reporter['_config'] = { capabilities: { browserName: 'chrome', browserVersion: '68' }, framework: 'mocha', hostname: 'browserstack.com' }
            await reporter.onTestSkip(testStats as any)
            expect(uploadEventDataSpy).toBeCalledTimes(1)
            expect(log.debug).toHaveBeenCalledTimes(0)
        })

        it('uploadEventData not called for cucumber', async () => {
            reporter['_config'] = { framework: 'cucumber' } as any
            await reporter.onTestSkip(testStats as any)
            expect(uploadEventDataSpy).toBeCalledTimes(0)
            expect(log.debug).toHaveBeenCalledTimes(0)
        })

        afterEach(() => {
            uploadEventDataSpy.mockClear()
            getCloudProviderSpy.mockClear()
        })
    })

    describe('getRunData app_lcnc metadata', () => {
        const reporter = new TestReporter({})
        const originalCentralUser = process.env[BROWSERSTACK_CENTRAL_USER]
        let getCloudProviderSpy: any
        let getPlatformVersionSpy: any

        beforeAll(() => {
            getCloudProviderSpy = vi.spyOn(utils, 'getCloudProvider').mockReturnValue('browserstack')
            getPlatformVersionSpy = vi.spyOn(utils, 'getPlatformVersion').mockImplementation(() => 'some version')
        })

        afterAll(() => {
            getCloudProviderSpy.mockRestore()
            getPlatformVersionSpy.mockRestore()
        })

        beforeEach(() => {
            process.env[BROWSERSTACK_CENTRAL_USER] = 'app_lcnc'
            TestMetadata.reset()
            reporter.onRunnerStart(runnerConfig as any)
        })

        afterEach(() => {
            TestMetadata.reset()
            if (originalCentralUser === undefined) {
                delete process.env[BROWSERSTACK_CENTRAL_USER]
            } else {
                process.env[BROWSERSTACK_CENTRAL_USER] = originalCentralUser
            }
        })

        it('attaches app_lcnc to a finished (passed/failed) test event, not only skipped', async () => {
            TestMetadata.set({ identifier: 'run-1' })
            const finishedStats = { ...testStats, state: 'passed' }
            const testData = await reporter.getRunData(finishedStats as any, 'TestRunFinished')
            expect(testData.app_lcnc).toEqual({ identifier: 'run-1' })
        })

        it('attaches app_lcnc to a skipped test event', async () => {
            TestMetadata.set({ identifier: 'run-1' })
            const testData = await reporter.getRunData(testStats as any, 'TestRunSkipped')
            expect(testData.result).toBe('skipped')
            expect(testData.app_lcnc).toEqual({ identifier: 'run-1' })
        })

        it('does not attach app_lcnc when no metadata was set', async () => {
            const finishedStats = { ...testStats, state: 'passed' }
            const testData = await reporter.getRunData(finishedStats as any, 'TestRunFinished')
            expect(testData.app_lcnc).toBeUndefined()
        })

        it('does not attach app_lcnc to hook events', async () => {
            TestMetadata.set({ identifier: 'run-1' })
            reporter.onSuiteStart({ title: 'suite title', file: 'filename' } as any)
            const hookStats = { ...testStats, type: 'hook', title: 'before each' }
            const testData = await reporter.getRunData(hookStats as any, 'HookRunFinished')
            expect(testData.app_lcnc).toBeUndefined()
        })
    })

    describe('needToSendData', function () {
        const reporter = new TestReporter({})
        beforeEach(() => {
            reporter['_observability'] = true
        })

        it('should return if not observability', () => {
            reporter['_observability'] = false
            expect(reporter.needToSendData('test', 'some event')).toBe(false)
        })

        it('should return false for cucumber', () => {
            reporter['_config'] = { framework: 'cucumber' } as any
            expect(reporter.needToSendData('test', 'some event')).toBe(false)
        })

        it('should return true for mocha is skip event', () => {
            reporter['_config'] = { framework: 'mocha' } as any
            expect(reporter.needToSendData('test', 'skip')).toBe(true)
        })

        it('should return true for jasmine if type is test', () => {
            reporter['_config'] = { framework: 'jasmine' } as any
            expect(reporter.needToSendData('test', 'some event')).toBe(true)
        })
    })

    describe('onTestStart', function () {
        let reporter: TestReporter
        let uploadEventDataSpy: any
        vi.spyOn(utils, 'getCloudProvider').mockReturnValue('browserstack')
        let testStartStats = { ...testStats }
        let getPlatformVersionSpy

        beforeAll(() => {
            getPlatformVersionSpy = vi.spyOn(utils, 'getPlatformVersion').mockImplementation(() => { return 'some version' })
        })

        afterAll(() => {
            getPlatformVersionSpy.mockReset()
        })

        beforeEach(() => {
            reporter = new TestReporter({})
            reporter['_observability'] = true
            reporter.onRunnerStart(runnerConfig as any)
            testStartStats = { ...testStats }
            uploadEventDataSpy = vi.spyOn(reporter['listener'], 'testStarted').mockImplementation(() => {})
        })

        afterEach(() => {
            uploadEventDataSpy.mockClear()
        })

        describe('mocha', () => {
            beforeEach(() => {
                // @ts-ignore
                reporter['_config'].framework = 'mocha'
            })

            it ("uploadEventData shouldn't get called", async () => {
                await reporter.onTestStart(testStartStats as any)
                expect(uploadEventDataSpy).toBeCalledTimes(0)
            })
        })

        describe('jasmine', function () {
            beforeEach(() => {
                // @ts-ignore
                reporter['_config'].framework = 'jasmine'
                testStartStats.state = 'pending'
            })

            it('uploadEventData called for jasmine', async () => {
                await reporter.onTestStart(testStartStats as any)
                expect(uploadEventDataSpy).toBeCalledTimes(1)
            })
        })
    })

    describe('onTestEnd', function () {
        let reporter: TestReporter, uploadEventDataSpy: any
        vi.spyOn(utils, 'getCloudProvider').mockReturnValue('browserstack')
        let testEndStats = { ...testStats }
        let getPlatformVersionSpy

        beforeAll(() => {
            getPlatformVersionSpy = vi.spyOn(utils, 'getPlatformVersion').mockImplementation(() => { return 'some version' })
        })

        afterAll(() => {
            getPlatformVersionSpy.mockReset()
        })

        beforeEach(() => {
            reporter = new TestReporter({})
            reporter['_observability'] = true
            reporter.onRunnerStart(runnerConfig as any)
            testEndStats = { ...testStats }
            uploadEventDataSpy = vi.spyOn(reporter['listener'], 'testFinished')
        })

        afterEach(() => {
            uploadEventDataSpy.mockClear()
        })

        describe('mocha', () => {
            beforeEach(() => {
                // @ts-ignore
                reporter['_config'].framework = 'mocha'
            })

            it ("uploadEventData shouldn't get called", async () => {
                await reporter.onTestEnd(testEndStats as any)
                expect(uploadEventDataSpy).toBeCalledTimes(0)
            })
        })

        describe('jasmine', function () {
            beforeEach(() => {
                // @ts-ignore
                reporter['_config'].framework = 'jasmine'
                testEndStats.state = 'passed'
            })

            it('uploadEventData called for passed tests', async () => {
                testEndStats.state = 'passed'
                await reporter.onTestEnd(testEndStats as any)
                expect(uploadEventDataSpy).toBeCalledTimes(1)
            })

            it('uploadEventData called for failed tests', async () => {
                testEndStats.state = 'failed'
                await reporter.onTestEnd(testEndStats as any)
                expect(uploadEventDataSpy).toBeCalledTimes(1)
            })
        })
    })

    describe('appendTestItemLog', function () {
        let reporter: TestReporter
        let sendDataSpy: any
        const logObj: StdLog = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            message: 'some log',
            kind: 'TEST_LOG',
            http_response: {}
        }
        let testLogObj: StdLog

        beforeEach(() => {
            reporter = new TestReporter({})
            reporter['_observability'] = true
            sendDataSpy = vi.spyOn(reporter['listener'], 'logCreated').mockImplementation(() => { return [] as any })
            testLogObj = { ...logObj }
        })

        it('should upload with current test uuid for log', function () {
            TestReporter['currentTest'] = { uuid: 'some_uuid' }
            reporter['appendTestItemLog'](testLogObj)
            expect(testLogObj.test_run_uuid).toBe('some_uuid')
            expect(sendDataSpy).toBeCalledTimes(1)
        })

        it('should upload with current hook uuid for log', function () {
            reporter['_currentHook'] = { uuid: 'some_uuid' }
            reporter['appendTestItemLog'](testLogObj)
            expect(testLogObj.hook_run_uuid).toBe('some_uuid')
            expect(sendDataSpy).toBeCalledTimes(1)
        })

        it('should not upload log if hook is finished', function () {
            TestReporter['currentTest'] = {}
            reporter['_currentHook'] = { uuid: 'some_uuid', finished: true }
            reporter['appendTestItemLog'](testLogObj)
            expect(testLogObj.hook_run_uuid).toBe(undefined)
            expect(testLogObj.test_run_uuid).toBe(undefined)
            expect(sendDataSpy).toBeCalledTimes(0)
        })

    })
})

describe('reporter onTestFail — sends mocha\'s failure through the CLI test events (SDK-7843)', () => {
    const timeout = new Error('Timeout of 300000ms exceeded. The execution in the test took too long.')
    const testStats = { title: 'should navigate via bottom nav', parent: 'Smoke: Home Navigation', error: timeout, _duration: 300004, retries: 0 }

    const makeReporter = (framework: string) => {
        const reporter = new TestReporter({})
        ;(reporter as unknown as { _config: unknown })._config = { framework }
        return reporter
    }
    const mockCli = (isRunning: boolean, trackEvent = vi.fn().mockResolvedValue(undefined), pinFailedAttempt = vi.fn()) => {
        vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({ isRunning: () => isRunning, getTestFramework: () => ({ trackEvent, pinFailedAttempt }) } as never)
        return trackEvent
    }

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('sends LOG_REPORT/POST then TEST/POST with mocha\'s result, under the test\'s identity', async () => {
        const trackEvent = mockCli(true)

        await makeReporter('mocha').onTestFail(testStats as never)

        const result = expect.objectContaining({ passed: false, error: timeout, duration: 300004, status: 'failed', exception: timeout.message })
        expect(trackEvent.mock.calls.map(([state, hook]) => `${String(state)}/${String(hook)}`)).toEqual([
            `${TestFrameworkState.LOG_REPORT}/${HookState.POST}`,
            `${TestFrameworkState.TEST}/${HookState.POST}`
        ])
        for (const [, , args] of trackEvent.mock.calls) {
            expect(args).toEqual(expect.objectContaining({ result, fromMochaFail: true }))
            expect(WdioMochaTestFramework.attemptKey(args.test)).toBe('Smoke: Home Navigation - should navigate via bottom nav')
        }
    })

    it('names a retried attempt the way the service\'s afterTest does', async () => {
        const trackEvent = mockCli(true)

        await makeReporter('mocha').onTestFail({ ...testStats, retries: 1 } as never)

        expect(WdioMochaTestFramework.attemptKey(trackEvent.mock.calls[0][2].test)).toBe('Smoke: Home Navigation - should navigate via bottom nav (retry 1)')
        expect(WdioMochaTestFramework.attemptKey({ title: testStats.title, parent: testStats.parent, _currentRetry: 1 } as never))
            .toBe('Smoke: Home Navigation - should navigate via bottom nav (retry 1)')
    })

    it('pins the test before queueing its finish, and reports that same test object', async () => {
        const order: string[] = []
        const pinFailedAttempt = vi.fn(() => {
            order.push('pin')
        })
        const trackEvent = mockCli(true, vi.fn(async (state: unknown) => {
            order.push(String(state))
        }), pinFailedAttempt)

        await makeReporter('mocha').onTestFail(testStats as never)

        expect(order).toEqual(['pin', String(TestFrameworkState.LOG_REPORT), String(TestFrameworkState.TEST)])
        const pinned = pinFailedAttempt.mock.calls[0][0]
        expect(trackEvent.mock.calls.map(([, , args]) => args.test)).toEqual([pinned, pinned])
        expect(trackEvent.mock.calls[0][2].test).toBe(pinned)
    })

    it('queues its finish on the skip-report chain, so a queued skip cannot interleave with it', async () => {
        const events: string[] = []
        const trackEvent = vi.fn(async (state: unknown, hook: unknown, args: { test: { title: string } }) => {
            events.push(`${args.test.title} ${String(state)}/${String(hook)} start`)
            await new Promise((resolve) => setTimeout(resolve, 10))
            events.push(`${args.test.title} ${String(state)}/${String(hook)} end`)
        })
        mockCli(true, trackEvent)
        const framework = { trackEvent } as never

        // wdio does not await either: the fail, then mocha's skip of a later test
        void makeReporter('mocha').onTestFail(testStats as never)
        void reportSkippedTest(framework, 'Smoke - skipped later', { title: 'skipped later', parent: 'Smoke' } as never, 'Smoke')
        await drainSkipReports()

        const failEnd = events.indexOf(`${testStats.title} ${TestFrameworkState.TEST}/${HookState.POST} end`)
        const skipStart = events.indexOf(`skipped later ${TestFrameworkState.INIT_TEST}/${HookState.PRE} start`)
        expect(failEnd).toBeGreaterThan(-1)
        expect(skipStart).toBeGreaterThan(failEnd)
    })

    it('does nothing on the classic flow, which sets the session status from after(result)', async () => {
        const trackEvent = mockCli(false)

        await makeReporter('mocha').onTestFail(testStats as never)

        expect(trackEvent).not.toHaveBeenCalled()
    })

    it('does nothing for other frameworks, whose afterTest is not run after after()', async () => {
        const trackEvent = mockCli(true)

        await makeReporter('cucumber').onTestFail(testStats as never)

        expect(trackEvent).not.toHaveBeenCalled()
    })
})
