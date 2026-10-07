import path from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { Frameworks } from '@wdio/types'

import BrowserstackService from '../src/service.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import TestFramework from '../src/cli/frameworks/testFramework.js'
import { TestFrameworkState } from '../src/cli/states/testFrameworkState.js'
import { AutomationFrameworkState } from '../src/cli/states/automationFrameworkState.js'
import { HookState } from '../src/cli/states/hookState.js'
import { finishCliTestOnFailure, resetCliTestFinishers } from '../src/cli/earlyTestFinish.js'
import * as bstackLogger from '../src/bstackLogger.js'

vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))
vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

/**
 * SDK-7843 — with a mocha timeout, mocha fails the test (and tells reporters) while its body and
 * wdio's afterTest are still pending; with `bail`, wdio then runs after() before that afterTest.
 * These drive the service hooks in exactly that order.
 */
describe('service — a timed-out mocha test is finished when mocha fails it (SDK-7843)', () => {
    let events: string[]
    let testTrackEvent: ReturnType<typeof vi.fn>

    const timedOutTest = { title: 'times out', parent: 'Suite', ctx: { test: {} } } as unknown as Frameworks.Test
    const failed = { passed: false, error: new Error('Timeout of 300000ms exceeded.'), duration: 300000, retries: { attempts: 0, limit: 0 }, exception: '', status: 'failed' } as Frameworks.TestResult

    const makeService = () => new BrowserstackService(
        { testObservability: false } as never,
        [] as never,
        { user: 'foo', key: 'bar', framework: 'mocha', mochaOpts: { bail: true } } as never
    )

    beforeEach(() => {
        resetCliTestFinishers()
        events = []
        // gRPC sends take real time; an instant mock would hide after() not waiting for the finish
        testTrackEvent = vi.fn().mockImplementation(async (state: unknown, hook: unknown, args: { result?: Frameworks.TestResult }) => {
            await new Promise((resolve) => setTimeout(resolve, 30))
            events.push(`${String(state)}/${String(hook)}${args?.result ? ` passed=${args.result.passed}` : ''}`)
        })
        vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({
            isRunning: () => true,
            getTestFramework: () => ({ trackEvent: testTrackEvent }),
            getAutomationFramework: () => ({
                trackEvent: vi.fn().mockImplementation(async (state: unknown, hook: unknown) => {
                    events.push(`${String(state)}/${String(hook)}`)
                })
            })
        } as never)
        vi.spyOn(TestFramework, 'getTrackedInstance').mockReturnValue({} as never)
        vi.spyOn(TestFramework, 'getState').mockReturnValue('uuid-timed-out' as never)
        vi.spyOn(TestFramework, 'setState').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('reports the failure, then marks the session, then ignores the late afterTest', async () => {
        const service = makeService()
        await service.beforeTest(timedOutTest)
        events.length = 0

        // mocha's `fail` reaches the reporter first...
        expect(finishCliTestOnFailure('Suite - times out', failed)).toBe(true)
        // ...then wdio runs after() before the timed-out test's afterTest
        await service.after(1)
        // ...and only then the late afterTest
        await service.afterTest(timedOutTest, undefined as never, { ...failed })

        const testPost = events.indexOf(`${TestFrameworkState.TEST}/${HookState.POST} passed=false`)
        const sessionStatusAt = events.indexOf(`${AutomationFrameworkState.EXECUTE}/${HookState.POST}`)
        expect(testPost).toBeGreaterThanOrEqual(0)
        // the failure is recorded before EXECUTE/POST, which is where AutomateModule marks the
        // session status
        expect(testPost).toBeLessThan(sessionStatusAt)
        // reported once: the late afterTest added no second LOG_REPORT/TEST POST
        expect(events.filter((e) => e.startsWith(`${TestFrameworkState.TEST}/${HookState.POST}`))).toHaveLength(1)
        expect(events.filter((e) => e.startsWith(`${TestFrameworkState.LOG_REPORT}/${HookState.POST}`))).toHaveLength(1)
    })

    it('still reports a normal failure from afterTest, and the reporter then does nothing', async () => {
        const service = makeService()
        await service.beforeTest(timedOutTest)
        events.length = 0

        await service.afterTest(timedOutTest, undefined as never, { ...failed })
        expect(finishCliTestOnFailure('Suite - times out', failed)).toBe(false)

        expect(events.filter((e) => e.startsWith(`${TestFrameworkState.TEST}/${HookState.POST}`))).toHaveLength(1)
    })

    it('reports afterTest for a test it never saw start, as before', async () => {
        const service = makeService()

        await service.afterTest({ title: 'unseen', parent: 'Suite', ctx: { test: {} } } as unknown as Frameworks.Test, undefined as never, { passed: true } as Frameworks.TestResult)

        expect(events.filter((e) => e.startsWith(`${TestFrameworkState.TEST}/${HookState.POST}`))).toHaveLength(1)
    })
})
