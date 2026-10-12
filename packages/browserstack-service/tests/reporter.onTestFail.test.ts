import path from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'

import TestReporter from '../src/reporter.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import WdioMochaTestFramework from '../src/cli/frameworks/wdioMochaTestFramework.js'
import { TestFrameworkState } from '../src/cli/states/testFrameworkState.js'
import { HookState } from '../src/cli/states/hookState.js'
import * as bstackLogger from '../src/bstackLogger.js'
import { drainSkipReports, reportSkippedTest } from '../src/cli/skipReporter.js'

vi.mock('@wdio/reporter', () => import(path.join(process.cwd(), '__mocks__', '@wdio/reporter')))
vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))
vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

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
