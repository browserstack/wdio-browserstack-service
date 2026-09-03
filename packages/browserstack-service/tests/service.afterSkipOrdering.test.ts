import path from 'node:path'

import { describe, expect, it, vi, beforeEach } from 'vitest'

import BrowserstackService from '../src/service.js'
import { drainSkipReports } from '../src/cli/skipReporter.js'
import { BrowserstackCLI } from '../src/cli/index.js'

vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))

vi.mock('../src/cli/skipReporter.js', () => ({
    drainSkipReports: vi.fn().mockResolvedValue(undefined),
    markTestStarted: vi.fn(),
    reportSuiteSkipped: vi.fn().mockResolvedValue(undefined),
    reportSkippedTest: vi.fn().mockResolvedValue(undefined),
    resolveSpecFile: vi.fn()
}))

vi.mock('../src/testOps/listener.js', () => ({
    default: { getInstance: () => ({ onWorkerEnd: vi.fn().mockResolvedValue(undefined) }) }
}))

vi.mock('../src/data-store.js', () => ({ saveWorkerData: vi.fn() }))

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

const flushPendingTestFinishEvent = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/cli/index.js', () => ({
    BrowserstackCLI: {
        getInstance: vi.fn()
    }
}))

/**
 * SDK-7493 — `service.after()` must drain the skip-report chain BEFORE flushing the
 * deferred test-finish.
 *
 * wdio does not await `onTestSkip`, so skip reports are still in flight when `after()`
 * starts, and each one ENDS by emitting mocha TEST/POST — which TestHubModule stashes in
 * its single-slot `pendingTestFinish` instead of sending. Flushing first therefore flushes
 * an empty slot and strands the stash that lands moments later; with `describe.skip()`
 * there is no next test to flush it either, so the test stays "in progress" until Test
 * Hub's ~60-min idle reap stamps the whole build `timeout`.
 *
 * This asserts the ORDER, which is the whole fix — both calls being present is not enough.
 */
describe('service.after() — skip drain must precede the deferred-finish flush (SDK-7493)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(BrowserstackCLI.getInstance).mockReturnValue({
            isRunning: () => true,
            modules: { TestHubModule: { flushPendingTestFinishEvent } },
            getAutomationFramework: () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) })
        } as never)
    })

    function fakeService() {
        return {
            _options: { setSessionStatus: false, setSessionName: false, preferScenarioName: false },
            _scenariosRanCount: 0,
            _lastScenarioName: undefined,
            _fullTitle: 'suite - test',
            _specsRan: true,
            _failReasons: [],
            _pureTestFailReasons: [],
            _hookFailReasons: [],
            _insightsHandler: undefined,
            _percyHandler: undefined,
            _cliTestUuids: new Map(),
            saveWorkerData: vi.fn()
        }
    }

    it('drains queued skip reports before flushing the deferred test finish', async () => {
        await BrowserstackService.prototype.after.call(fakeService() as never, 0)

        expect(drainSkipReports).toHaveBeenCalledTimes(1)
        expect(flushPendingTestFinishEvent).toHaveBeenCalledTimes(1)

        const drainOrder = vi.mocked(drainSkipReports).mock.invocationCallOrder[0]
        const flushOrder = flushPendingTestFinishEvent.mock.invocationCallOrder[0]
        expect(drainOrder).toBeLessThan(flushOrder)
    })

    it('still flushes when the skip drain rejects — a drain failure must not strand the finish', async () => {
        vi.mocked(drainSkipReports).mockRejectedValueOnce(new Error('skip chain blew up'))

        await BrowserstackService.prototype.after.call(fakeService() as never, 0)

        expect(flushPendingTestFinishEvent).toHaveBeenCalledTimes(1)
    })
})
