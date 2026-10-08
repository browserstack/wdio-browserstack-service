import path from 'node:path'
import logger from '@wdio/logger'
import { describe, expect, it, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import type { StdLog } from '../src/index.js'

import TestReporter from '../src/reporter.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import WdioJasmineTestFramework from '../src/cli/frameworks/wdioJasmineTestFramework.js'
import { TestFrameworkState } from '../src/cli/states/testFrameworkState.js'
import { HookState } from '../src/cli/states/hookState.js'
import * as utils from '../src/util.js'
import * as bstackLogger from '../src/bstackLogger.js'

const log = logger('test')

// Fake only the clock (for deterministic timestamps). Faking setTimeout/setImmediate
// at module scope stalls Vitest's own worker finalization and hangs the run.
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

    describe('jasmine CLI feed', () => {
        const jasmineRunnerConfig = {
            type: 'runner',
            cid: '0-0',
            capabilities: { browserName: 'chrome', browserVersion: '151' },
            config: { framework: 'jasmine', hostname: 'hub.browserstack.com' },
            specs: ['/work/test/p2/nested.spec.js'],
            sessionId: 'sessionId'
        }
        const suite = { title: 'Nested outer', file: '/work/test/p2/nested.spec.js' }
        const jasmineTestStats = () => ({
            type: 'test',
            uid: 'outer passing test0',
            title: 'outer passing test',
            fullTitle: 'Nested outer outer passing test',
            start: new Date('2026-09-25T15:34:12.259Z'),
            _duration: 0,
            retries: 0,
            state: 'pending',
        })
        const hookStats = () => ({ type: 'hook', uid: 'h', title: '"before all" hook', start: new Date(), _duration: 0 })
        const logEntry = () => ({ timestamp: new Date().toISOString(), level: 'INFO', message: 'console line', kind: 'TEST_LOG' as const, http_response: {} })

        let reporter: TestReporter
        let listener: Record<string, ReturnType<typeof vi.spyOn>>
        let framework: WdioJasmineTestFramework
        let getInstanceSpy: ReturnType<typeof vi.spyOn> | undefined
        let getGitMetaDataSpy: ReturnType<typeof vi.spyOn>
        // the reporter-sourced trackEvent calls, as [state, hookState, args]
        const reporterCalls = () => vi.mocked(framework.trackEvent).mock.calls.filter(([, , args]) => (args as Record<string, unknown>)?.source === 'reporter')

        const setCli = (running: boolean, testFramework: unknown) => {
            getInstanceSpy = vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({
                isRunning: () => running,
                getTestFramework: () => testFramework,
            } as unknown as BrowserstackCLI)
        }

        beforeEach(async () => {
            vi.spyOn(utils, 'getCloudProvider').mockReturnValue('browserstack')
            getGitMetaDataSpy = vi.spyOn(utils, 'getGitMetaData').mockResolvedValue(undefined as any)
            framework = new WdioJasmineTestFramework(['WebdriverIO-jasmine'], { 'WebdriverIO-jasmine': '9.39.0' }, 'bin')
            vi.spyOn(framework, 'trackEvent').mockImplementation(async (state, hookState, args = {}) => {
                if (state === TestFrameworkState.TEST && hookState === HookState.PRE) {
                    args.testUuid = 'cli-uuid'
                }
            })

            reporter = new TestReporter({})
            await reporter.onRunnerStart(jasmineRunnerConfig as any)
            reporter.onSuiteStart(suite as any)
            listener = {
                testStarted: vi.spyOn(reporter['listener'], 'testStarted').mockImplementation(() => {}),
                testFinished: vi.spyOn(reporter['listener'], 'testFinished').mockImplementation(() => {}),
                hookStarted: vi.spyOn(reporter['listener'], 'hookStarted').mockImplementation(() => {}),
                hookFinished: vi.spyOn(reporter['listener'], 'hookFinished').mockImplementation(() => {}),
                logCreated: vi.spyOn(reporter['listener'], 'logCreated').mockImplementation(() => {}),
            }
        })

        afterEach(() => {
            getInstanceSpy?.mockRestore()
            getInstanceSpy = undefined
            getGitMetaDataSpy.mockRestore()
            for (const spy of Object.values(listener)) {
                spy.mockRestore()
            }
        })

        describe('on the CLI flow', () => {
            beforeEach(() => setCli(true, framework))

            it('feeds every test and hook event to the framework and enqueues nothing on the legacy Listener', async () => {
                const stats = jasmineTestStats()
                await reporter.onHookStart(hookStats() as any)
                await reporter.onHookEnd(hookStats() as any)
                await reporter.onTestStart(stats as any)
                await reporter.onTestEnd({ ...stats, state: 'passed' } as any)
                await reporter.appendTestItemLog(logEntry())

                expect(reporterCalls().map(([state, hookState]) => [state, hookState])).toEqual([
                    [TestFrameworkState.BEFORE_ALL, HookState.PRE],
                    [TestFrameworkState.BEFORE_ALL, HookState.POST],
                    [TestFrameworkState.TEST, HookState.PRE],
                    [TestFrameworkState.TEST, HookState.POST],
                    [TestFrameworkState.LOG, HookState.POST],
                ])
                expect(framework.trackEvent).toHaveBeenCalledTimes(5)
                for (const spy of Object.values(listener)) {
                    expect(spy).not.toHaveBeenCalled()
                }
            })

            it('passes the suite stack and suite file', async () => {
                await reporter.onTestStart(jasmineTestStats() as any)
                expect(framework.trackEvent).toHaveBeenCalledWith(TestFrameworkState.TEST, HookState.PRE, expect.objectContaining({
                    source: 'reporter',
                    testStats: expect.objectContaining({ fullTitle: 'Nested outer outer passing test' }),
                    context: { scopes: ['Nested outer'], suiteFile: '/work/test/p2/nested.spec.js' },
                }))
            })

            it('passes hook stats with the suite context, and log entries as they came', async () => {
                const hook = hookStats()
                await reporter.onHookStart(hook as any)
                await reporter.onHookEnd(hook as any)
                const entry = logEntry()
                await reporter.appendTestItemLog(entry)
                const context = { scopes: ['Nested outer'], suiteFile: '/work/test/p2/nested.spec.js' }
                expect(reporterCalls().map(([, , args]) => args)).toEqual([
                    { source: 'reporter', hookStats: hook, context },
                    { source: 'reporter', hookStats: hook, context },
                    { source: 'reporter', logEntry: entry },
                ])
            })

            it('reports an each-hook in NONE, leaving the class to drop it', async () => {
                await reporter.onHookStart({ ...hookStats(), title: '"before each" hook' } as any)
                expect(framework.trackEvent).toHaveBeenCalledWith(TestFrameworkState.NONE, HookState.PRE, expect.objectContaining({ source: 'reporter' }))
            })

            it('records nothing for the spec when the framework minted no uuid', async () => {
                vi.mocked(framework.trackEvent).mockResolvedValue(undefined)
                ;(TestReporter as any).currentTest = {}
                await reporter.onTestStart({ ...jasmineTestStats(), fullTitle: 'No uuid spec' } as any)
                expect(TestReporter.getTests()['No uuid spec']).toBeUndefined()
                expect((TestReporter as any).currentTest).toEqual({})
            })

            it('records the CLI uuid for the spec so command-result lookups resolve to the wire uuid', async () => {
                await reporter.onTestStart(jasmineTestStats() as any)
                expect(TestReporter.getTests()['Nested outer outer passing test']).toEqual({ uuid: 'cli-uuid' })
            })

            it('names the current test for Percy\'s testCase, as legacy getRunData did', async () => {
                await reporter.onTestStart(jasmineTestStats() as any)
                expect((TestReporter as any).currentTest).toMatchObject({ uuid: 'cli-uuid', name: 'outer passing test' })
            })

            it('keeps legacy\'s end stamp and forced hook pass on the WDIO stats objects', async () => {
                const stats = jasmineTestStats() as Record<string, unknown>
                await reporter.onTestEnd(stats as any)
                expect(stats.end).toBeInstanceOf(Date)
                const hook = hookStats() as Record<string, unknown>
                await reporter.onHookEnd(hook as any)
                expect(hook.state).toBe('passed')
            })

            it('drops <unknown test>', async () => {
                await reporter.onTestStart({ ...jasmineTestStats(), fullTitle: '<unknown test>' } as any)
                await reporter.onTestEnd({ ...jasmineTestStats(), fullTitle: '<unknown test>' } as any)
                expect(framework.trackEvent).not.toHaveBeenCalled()
            })

            it('sends nothing when Test Observability is opted out', async () => {
                reporter['_observability'] = false
                await reporter.onTestStart(jasmineTestStats() as any)
                expect(framework.trackEvent).not.toHaveBeenCalled()
                expect(listener.testStarted).not.toHaveBeenCalled()
            })

            it('never falls back to the legacy Listener when the tracker is missing', async () => {
                setCli(true, null)
                await reporter.onTestStart(jasmineTestStats() as any)
                await reporter.appendTestItemLog(logEntry())
                expect(listener.testStarted).not.toHaveBeenCalled()
                expect(listener.logCreated).not.toHaveBeenCalled()
            })

            it('reports unsynchronised while the framework has queued events', () => {
                const isIdle = vi.spyOn(framework, 'isIdle').mockReturnValue(false)
                expect(reporter.isSynchronised).toBe(false)
                isIdle.mockReturnValue(true)
                expect(reporter.isSynchronised).toBe(true)
            })

            it('is synchronised when the CLI test framework is not jasmine\'s', () => {
                setCli(true, { isIdle: () => false })
                expect(reporter.isSynchronised).toBe(true)
            })
        })

        describe('on the legacy flow', () => {
            beforeEach(() => setCli(false, null))

            it('enqueues on the legacy Listener and never touches the framework', async () => {
                const stats = jasmineTestStats()
                await reporter.onHookStart(hookStats() as any)
                await reporter.onHookEnd(hookStats() as any)
                await reporter.onTestStart(stats as any)
                await reporter.onTestEnd({ ...stats, state: 'passed' } as any)
                reporter['_currentHook'] = {}
                await reporter.appendTestItemLog(logEntry())

                expect(listener.hookStarted).toHaveBeenCalledTimes(1)
                expect(listener.hookFinished).toHaveBeenCalledTimes(1)
                expect(listener.testStarted).toHaveBeenCalledTimes(1)
                expect(listener.testFinished).toHaveBeenCalledTimes(1)
                expect(listener.logCreated).toHaveBeenCalledTimes(1)
                expect(framework.trackEvent).not.toHaveBeenCalled()
                expect(TestReporter.getTests()['Nested outer outer passing test']).toEqual({ uuid: '123456789' })
            })
        })

        describe('mocha on the CLI flow', () => {
            beforeEach(() => setCli(true, framework))

            it('leaves the mocha arm unchanged: no start/end publishing from the reporter', async () => {
                reporter['_config']!.framework = 'mocha'
                await reporter.onTestStart(jasmineTestStats() as any)
                await reporter.onTestEnd({ ...jasmineTestStats(), state: 'passed' } as any)
                expect(framework.trackEvent).not.toHaveBeenCalled()
                expect(listener.testStarted).not.toHaveBeenCalled()
                expect(listener.testFinished).not.toHaveBeenCalled()
            })
        })
    })
})
