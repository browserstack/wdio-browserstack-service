import path from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'

import TestReporter from '../src/reporter.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import WdioMochaTestFramework from '../src/cli/frameworks/wdioMochaTestFramework.js'
import { TestFrameworkState } from '../src/cli/states/testFrameworkState.js'
import { HookState } from '../src/cli/states/hookState.js'
import * as bstackLogger from '../src/bstackLogger.js'

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
    const mockCli = (isRunning: boolean) => {
        const trackEvent = vi.fn().mockResolvedValue(undefined)
        vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({ isRunning: () => isRunning, getTestFramework: () => ({ trackEvent }) } as never)
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
