import { describe, it, expect, beforeEach, vi } from 'vitest'

import WdioMochaTestFramework from '../../../src/cli/frameworks/wdioMochaTestFramework.js'
import TestFrameworkInstance from '../../../src/cli/instances/testFrameworkInstance.js'
import TrackedContext from '../../../src/cli/instances/trackedContext.js'
import { TestFrameworkState } from '../../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../../src/cli/states/hookState.js'
import { TestFrameworkConstants } from '../../../src/cli/frameworks/constants/testFrameworkConstants.js'

vi.mock('../../../src/cli/cliLogger.js', () => ({
    BStackLogger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
    }
}))

describe('WdioMochaTestFramework.trackHookEvents (POST result derivation)', () => {
    let framework: WdioMochaTestFramework
    let instance: TestFrameworkInstance
    const key = 'AFTER_EACH'

    beforeEach(() => {
        framework = new WdioMochaTestFramework(['mocha'], { mocha: '10.0.0' }, 'bin-session-1')
        const context = new TrackedContext('ctx-1', 1, 1, 'test')
        instance = new TestFrameworkInstance(
            context,
            ['mocha'],
            { mocha: '10.0.0' },
            TestFrameworkState.AFTER_EACH,
            HookState.POST
        )
    })

    // Seed a started hook (as the PRE branch would), run the POST branch, and return the
    // result written onto the finished hook.
    const runPost = async (result: unknown): Promise<unknown> => {
        const startedHook: Record<string, unknown> = {
            key,
            [TestFrameworkConstants.KEY_HOOK_RESULT]: TestFrameworkConstants.DEFAULT_HOOK_RESULT
        }
        instance.updateMultipleEntries({
            [TestFrameworkConstants.KEY_HOOKS_STARTED]: new Map([[key, [startedHook]]]),
            [TestFrameworkConstants.KEY_HOOKS_FINISHED]: new Map()
        })

        await framework.trackHookEvents(
            instance,
            TestFrameworkState.AFTER_EACH,
            HookState.POST,
            { test: { title: 'afterEach hook', file: '/spec.js' } as any, result }
        )

        const finished = instance.getData(TestFrameworkConstants.KEY_HOOKS_FINISHED) as Map<string, Record<string, unknown>[]>
        const hook = finished.get(key)?.pop()
        return hook?.[TestFrameworkConstants.KEY_HOOK_RESULT]
    }

    it("derives 'passed' from { passed: true }", async () => {
        expect(await runPost({ passed: true })).toBe('passed')
    })

    it("derives 'failed' from { passed: false, skipped: false, error }", async () => {
        expect(await runPost({ passed: false, skipped: false, error: { message: 'boom' } })).toBe('failed')
    })

    it("derives 'skipped' from { passed: false, skipped: true }", async () => {
        expect(await runPost({ passed: false, skipped: true })).toBe('skipped')
    })

    it('overwrites the default pending result rather than leaving it unset', async () => {
        // Guards the regression: previously the value was read from the never-populated
        // testResult.status, so the finished hook kept the default 'pending'.
        expect(TestFrameworkConstants.DEFAULT_HOOK_RESULT).toBe('pending')
        expect(await runPost({ passed: false, skipped: false, error: { message: 'x' } })).not.toBe(
            TestFrameworkConstants.DEFAULT_HOOK_RESULT
        )
    })
})
