import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as bstackLogger from '../../src/bstackLogger.js'

import WdioMochaTestFramework from '../../src/cli/frameworks/wdioMochaTestFramework.js'
import TestFramework from '../../src/cli/frameworks/testFramework.js'
import { TestFrameworkState } from '../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../src/cli/states/hookState.js'
import { BStackLogger as cliLogger } from '../../src/cli/cliLogger.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

describe('SDK-7843 — a log written before the first mocha hook is dropped quietly', () => {
    let framework: WdioMochaTestFramework
    let errorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        framework = new WdioMochaTestFramework(['WebdriverIO', 'mocha'], {}, 'bin-session-id')
        errorSpy = vi.spyOn(cliLogger, 'error').mockImplementation(() => {})
        vi.spyOn(cliLogger, 'info').mockImplementation(() => {})
        vi.spyOn(cliLogger, 'debug').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('does not log an ERROR for console output from wdio\'s `before` hook', async () => {
        // wdio's `before` runs before mocha's `before all`, so no instance is tracked yet.
        vi.spyOn(TestFramework, 'getTrackedInstance').mockReturnValue(null as any)
        const resolveSpy = vi.spyOn(framework, 'resolveInstance')

        await framework.trackEvent(TestFrameworkState.LOG, HookState.POST, {
            logEntry: { kind: 'TEST_LOG', message: '[SelfHealer] Installed', level: 'info', timestamp: new Date().toISOString() }
        })

        expect(errorSpy).not.toHaveBeenCalled()
        expect(resolveSpy).not.toHaveBeenCalled()
    })

    it('still resolves the instance for a log once a test or hook is tracked', async () => {
        vi.spyOn(TestFramework, 'getTrackedInstance').mockReturnValue({} as any)
        const resolveSpy = vi.spyOn(framework, 'resolveInstance').mockReturnValue(null)

        await framework.trackEvent(TestFrameworkState.LOG, HookState.POST, { logEntry: {} })

        expect(resolveSpy).toHaveBeenCalledOnce()
    })

    it('still reports a missing instance for non-log events', async () => {
        vi.spyOn(TestFramework, 'getTrackedInstance').mockReturnValue(null as any)

        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, {})

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('resolveInstance: unable to resolve/create instance'))
    })
})
