import path from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import TestReporter from '../src/reporter.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import WdioJasmineTestFramework from '../src/cli/frameworks/wdioJasmineTestFramework.js'
import * as utils from '../src/util.js'
import * as bstackLogger from '../src/bstackLogger.js'

vi.mock('uuid', () => ({ v4: () => 'legacy-uuid' }))
vi.mock('@wdio/reporter', () => import(path.join(process.cwd(), '__mocks__', '@wdio/reporter')))
vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

const runnerConfig = {
    type: 'runner',
    cid: '0-0',
    capabilities: { browserName: 'chrome', browserVersion: '151' },
    config: { framework: 'jasmine', hostname: 'hub.browserstack.com' },
    specs: ['/work/test/p2/nested.spec.js'],
    sessionId: 'sessionId'
}

const suite = { title: 'Nested outer', file: '/work/test/p2/nested.spec.js' }
const testStats = () => ({
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

describe('reporter jasmine arm', () => {
    let reporter: TestReporter
    let listener: Record<string, ReturnType<typeof vi.spyOn>>
    let framework: WdioJasmineTestFramework

    const setCli = (running: boolean, testFramework: unknown) => {
        vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({
            isRunning: () => running,
            getTestFramework: () => testFramework,
        } as unknown as BrowserstackCLI)
    }

    beforeEach(async () => {
        vi.spyOn(utils, 'getCloudProvider').mockReturnValue('browserstack')
        vi.spyOn(utils, 'getGitMetaData').mockResolvedValue(undefined as any)
        framework = new WdioJasmineTestFramework(['WebdriverIO-jasmine'], { 'WebdriverIO-jasmine': '9.39.0' }, 'bin')
        for (const m of ['onReporterTestStart', 'onReporterTestEnd', 'onReporterHookStart', 'onReporterHookEnd', 'onReporterLog'] as const) {
            vi.spyOn(framework, m)
        }
        vi.mocked(framework.onReporterTestStart).mockReturnValue('cli-uuid')
        vi.mocked(framework.onReporterTestEnd).mockReturnValue(undefined)
        vi.mocked(framework.onReporterHookStart).mockReturnValue(undefined)
        vi.mocked(framework.onReporterHookEnd).mockReturnValue(undefined)
        vi.mocked(framework.onReporterLog).mockReturnValue(undefined)

        reporter = new TestReporter({})
        await reporter.onRunnerStart(runnerConfig as any)
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
        vi.restoreAllMocks()
    })

    describe('on the CLI flow', () => {
        beforeEach(() => setCli(true, framework))

        it('feeds every test and hook event to the framework and enqueues nothing on the legacy Listener', async () => {
            const stats = testStats()
            await reporter.onHookStart(hookStats() as any)
            await reporter.onHookEnd(hookStats() as any)
            await reporter.onTestStart(stats as any)
            await reporter.onTestEnd({ ...stats, state: 'passed' } as any)
            await reporter.appendTestItemLog(logEntry())

            expect(framework.onReporterHookStart).toHaveBeenCalledTimes(1)
            expect(framework.onReporterHookEnd).toHaveBeenCalledTimes(1)
            expect(framework.onReporterTestStart).toHaveBeenCalledTimes(1)
            expect(framework.onReporterTestEnd).toHaveBeenCalledTimes(1)
            expect(framework.onReporterLog).toHaveBeenCalledTimes(1)
            for (const spy of Object.values(listener)) {
                expect(spy).not.toHaveBeenCalled()
            }
        })

        it('passes the suite stack and suite file', async () => {
            await reporter.onTestStart(testStats() as any)
            expect(framework.onReporterTestStart).toHaveBeenCalledWith(
                expect.objectContaining({ fullTitle: 'Nested outer outer passing test' }),
                { scopes: ['Nested outer'], suiteFile: '/work/test/p2/nested.spec.js' }
            )
        })

        it('records the CLI uuid for the spec so command-result lookups resolve to the wire uuid', async () => {
            await reporter.onTestStart(testStats() as any)
            expect(TestReporter.getTests()['Nested outer outer passing test']).toEqual({ uuid: 'cli-uuid' })
        })

        it('keeps legacy\'s end stamp and forced hook pass on the WDIO stats objects', async () => {
            const stats = testStats() as Record<string, unknown>
            await reporter.onTestEnd(stats as any)
            expect(stats.end).toBeInstanceOf(Date)
            const hook = hookStats() as Record<string, unknown>
            await reporter.onHookEnd(hook as any)
            expect(hook.state).toBe('passed')
        })

        it('drops <unknown test>', async () => {
            await reporter.onTestStart({ ...testStats(), fullTitle: '<unknown test>' } as any)
            await reporter.onTestEnd({ ...testStats(), fullTitle: '<unknown test>' } as any)
            expect(framework.onReporterTestStart).not.toHaveBeenCalled()
            expect(framework.onReporterTestEnd).not.toHaveBeenCalled()
        })

        it('sends nothing when Test Observability is opted out', async () => {
            reporter['_observability'] = false
            await reporter.onTestStart(testStats() as any)
            expect(framework.onReporterTestStart).not.toHaveBeenCalled()
            expect(listener.testStarted).not.toHaveBeenCalled()
        })

        it('never falls back to the legacy Listener when the tracker is missing', async () => {
            setCli(true, null)
            await reporter.onTestStart(testStats() as any)
            await reporter.appendTestItemLog(logEntry())
            expect(listener.testStarted).not.toHaveBeenCalled()
            expect(listener.logCreated).not.toHaveBeenCalled()
        })

        it('reports unsynchronised while the framework has queued events', () => {
            const spy = vi.spyOn(WdioJasmineTestFramework, 'isIdle').mockReturnValue(false)
            expect(reporter.isSynchronised).toBe(false)
            spy.mockReturnValue(true)
            expect(reporter.isSynchronised).toBe(true)
        })
    })

    describe('on the legacy flow', () => {
        beforeEach(() => setCli(false, null))

        it('enqueues on the legacy Listener and never touches the framework', async () => {
            const stats = testStats()
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
            expect(framework.onReporterTestStart).not.toHaveBeenCalled()
            expect(framework.onReporterLog).not.toHaveBeenCalled()
            expect(TestReporter.getTests()['Nested outer outer passing test']).toEqual({ uuid: 'legacy-uuid' })
        })
    })

    describe('mocha on the CLI flow', () => {
        beforeEach(() => setCli(true, framework))

        it('leaves the mocha arm unchanged: no start/end publishing from the reporter', async () => {
            reporter['_config']!.framework = 'mocha'
            await reporter.onTestStart(testStats() as any)
            await reporter.onTestEnd({ ...testStats(), state: 'passed' } as any)
            expect(framework.onReporterTestStart).not.toHaveBeenCalled()
            expect(listener.testStarted).not.toHaveBeenCalled()
            expect(listener.testFinished).not.toHaveBeenCalled()
        })
    })
})
