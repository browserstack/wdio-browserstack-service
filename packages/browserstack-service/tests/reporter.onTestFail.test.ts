import path from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import TestReporter from '../src/reporter.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import * as earlyTestFinish from '../src/cli/earlyTestFinish.js'
import * as bstackLogger from '../src/bstackLogger.js'

vi.mock('@wdio/reporter', () => import(path.join(process.cwd(), '__mocks__', '@wdio/reporter')))
vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))
vi.mock('../src/cli/earlyTestFinish.js', () => ({ finishCliTestOnFailure: vi.fn().mockReturnValue(true) }))
vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

describe('reporter onTestFail — hands mocha\'s failure to the CLI finish (SDK-7843)', () => {
    const timeout = new Error('Timeout of 300000ms exceeded. The execution in the test took too long.')
    const testStats = { title: 'should navigate via bottom nav', parent: 'Smoke: Home Navigation', error: timeout, _duration: 300004, retries: 0 }

    const makeReporter = (framework: string) => {
        const reporter = new TestReporter({})
        ;(reporter as unknown as { _config: unknown })._config = { framework }
        return reporter
    }

    beforeEach(() => {
        vi.mocked(earlyTestFinish.finishCliTestOnFailure).mockClear()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('reports a mocha failure on the CLI flow under the same identity the service registered', () => {
        vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({ isRunning: () => true } as never)

        makeReporter('mocha').onTestFail(testStats as never)

        expect(earlyTestFinish.finishCliTestOnFailure).toHaveBeenCalledWith(
            'Smoke: Home Navigation - should navigate via bottom nav',
            expect.objectContaining({ passed: false, error: timeout, duration: 300004, status: 'failed', exception: timeout.message })
        )
    })

    it('does nothing on the classic flow, which sets the session status from after(result)', () => {
        vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({ isRunning: () => false } as never)

        makeReporter('mocha').onTestFail(testStats as never)

        expect(earlyTestFinish.finishCliTestOnFailure).not.toHaveBeenCalled()
    })

    it('does nothing for other frameworks, whose afterTest is not run after after()', () => {
        vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({ isRunning: () => true } as never)

        makeReporter('cucumber').onTestFail(testStats as never)

        expect(earlyTestFinish.finishCliTestOnFailure).not.toHaveBeenCalled()
    })
})
