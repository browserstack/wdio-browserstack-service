import path from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { Frameworks } from '@wdio/types'

import BrowserstackService from '../src/service.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import TestFramework from '../src/cli/frameworks/testFramework.js'
import { TestFrameworkState } from '../src/cli/states/testFrameworkState.js'
import { AutomationFrameworkState } from '../src/cli/states/automationFrameworkState.js'
import { HookState } from '../src/cli/states/hookState.js'
import * as bstackLogger from '../src/bstackLogger.js'

vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))
vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

/**
 * SDK-7843 — with a mocha timeout, mocha fails the test (the reporter sends its finish) while its
 * body and wdio's afterTest are still pending; with `bail`, wdio then runs after() before that
 * afterTest. after() must let that finish land before EXECUTE/POST, where AutomateModule marks the
 * session status.
 */
describe('service after() — settles test finishes before the session status is marked (SDK-7843)', () => {
    let events: string[]
    let settle: ReturnType<typeof vi.fn>
    let trackEvent: ReturnType<typeof vi.fn>

    const makeService = () => new BrowserstackService(
        { testObservability: false } as never,
        [] as never,
        { user: 'foo', key: 'bar', framework: 'mocha', mochaOpts: { bail: true } } as never
    )

    beforeEach(() => {
        events = []
        // the reporter's finish is still being sent when after() starts
        settle = vi.fn().mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30))
            events.push('settleTestFinishes')
        })
        trackEvent = vi.fn().mockImplementation(async (state: unknown, hook: unknown) => {
            events.push(`${String(state)}/${String(hook)}`)
        })
        vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({
            isRunning: () => true,
            getTestFramework: () => ({ trackEvent, settleTestFinishes: settle }),
            getAutomationFramework: () => ({
                trackEvent: vi.fn().mockImplementation(async (state: unknown, hook: unknown) => {
                    events.push(`${String(state)}/${String(hook)}`)
                })
            })
        } as never)
        vi.spyOn(TestFramework, 'getTrackedInstance').mockReturnValue({} as never)
        vi.spyOn(TestFramework, 'getState').mockReturnValue('uuid-1' as never)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('settles before EXECUTE/POST', async () => {
        await makeService().after(1)

        expect(events).toEqual(['settleTestFinishes', `${AutomationFrameworkState.EXECUTE}/${HookState.POST}`])
    })

    it('leaves the tracked test run alone in afterTest; the CLI framework picks the test\'s own', async () => {
        const setState = vi.spyOn(TestFramework, 'setState')
        const service = makeService()
        const test = { title: 'times out', parent: 'Suite', ctx: { test: {} } } as unknown as Frameworks.Test

        await service.beforeTest(test)
        await service.afterTest(test, undefined as never, { passed: false, error: new Error('Timeout'), duration: 1 } as Frameworks.TestResult)

        expect(setState).not.toHaveBeenCalled()
        expect(events.filter((e) => e.startsWith(TestFrameworkState.TEST))).toEqual([
            `${TestFrameworkState.TEST}/${HookState.PRE}`,
            `${TestFrameworkState.TEST}/${HookState.POST}`
        ])
    })
})
