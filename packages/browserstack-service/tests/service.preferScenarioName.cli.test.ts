import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import BrowserstackService from '../src/service.js'
import { BrowserstackCLI } from '../src/cli/index.js'

vi.mock('../src/cli/index.js', () => ({
    BrowserstackCLI: {
        getInstance: () => ({
            isRunning: () => false,
            getTestFramework: () => null,
            getAutomationFramework: () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) })
        })
    }
}))

describe('preferScenarioName on the CLI flow — parity row 40', () => {
    let getInstanceSpy: ReturnType<typeof vi.spyOn> | undefined
    let overrideSessionName: ReturnType<typeof vi.fn>

    const makeService = (framework: string, options: Record<string, unknown> = {}) => new BrowserstackService(
        { testObservability: false, preferScenarioName: true, setSessionName: true, setSessionStatus: true, ...options } as never,
        [] as never,
        { user: 'foo', key: 'bar', framework, cucumberOpts: { strict: false } } as never
    )

    beforeEach(() => {
        overrideSessionName = vi.fn().mockResolvedValue(undefined)
        getInstanceSpy = vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({
            isRunning: () => true,
            getTestFramework: () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }),
            getAutomationFramework: () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }),
            modules: { AutomateModule: { overrideSessionName } }
        } as never)
    })

    afterEach(() => {
        getInstanceSpy?.mockRestore()
    })

    it('renames the session to the scenario name when exactly one scenario ran', async () => {
        const service = makeService('cucumber')
        await service.afterScenario({ pickle: { name: 'Can do something single' }, result: { status: 'passed' } } as never)

        await service.after(0)

        expect(overrideSessionName).toHaveBeenCalledTimes(1)
        expect(overrideSessionName).toHaveBeenCalledWith('Can do something single')
    })

    // Legacy's `=== 1` is the specification, not a lower bound.
    it('does NOT rename when two scenarios ran', async () => {
        const service = makeService('cucumber')
        await service.afterScenario({ pickle: { name: 'Scenario one' }, result: { status: 'passed' } } as never)
        await service.afterScenario({ pickle: { name: 'Scenario two' }, result: { status: 'passed' } } as never)

        await service.after(0)

        expect(overrideSessionName).not.toHaveBeenCalled()
    })

    it('does NOT rename when preferScenarioName is absent', async () => {
        const service = makeService('cucumber', { preferScenarioName: undefined })
        await service.afterScenario({ pickle: { name: 'Can do something single' }, result: { status: 'passed' } } as never)

        await service.after(0)

        expect(overrideSessionName).not.toHaveBeenCalled()
    })

    it('does NOT rename when the only scenario was skipped', async () => {
        const service = makeService('cucumber')
        await service.afterScenario({ pickle: { name: 'Can do something single' }, result: { status: 'skipped' } } as never)

        await service.after(0)

        expect(overrideSessionName).not.toHaveBeenCalled()
    })

    // The discriminating pair: identical options and an identical "exactly one unit ran", opposite
    // answers. `_scenariosRanCount` / `_lastScenarioName` are written only by cucumber's
    // afterScenario, so wdio_mocha cannot reach the rename however preferScenarioName is set.
    it('leaves wdio_mocha untouched on the same input', async () => {
        const service = makeService('mocha')
        await service.afterTest(
            { title: 'a test', parent: 'a suite' } as never,
            undefined as never,
            { passed: true, duration: 1, retries: { attempts: 0, limit: 0 }, exception: '', status: 'passed' } as never
        )

        await service.after(0)

        expect(overrideSessionName).not.toHaveBeenCalled()
        expect(service['_scenariosRanCount']).toBe(0)
    })
})

describe('_cucumberTestResult failure reason — parity row 39 adjacent', () => {
    const makeService = (strict: boolean) => new BrowserstackService(
        { testObservability: false } as never,
        [] as never,
        { user: 'foo', key: 'bar', framework: 'cucumber', cucumberOpts: { strict } } as never
    )

    const world = (status: string, message?: string) => ({
        pickle: { name: 'CfgGate pending scenario' },
        result: message ? { status, message } : { status }
    })

    it('synthesises legacy\'s pending reason when strict makes a pending scenario fail', () => {
        const result = makeService(true)['_cucumberTestResult'](world('PENDING') as never)

        expect(result.passed).toBe(false)
        expect(result.error?.message).toBe('Some steps/hooks are pending for scenario "CfgGate pending scenario"')
    })

    it('leaves a pending scenario unfailed — and unreasoned — when strict is off', () => {
        const result = makeService(false)['_cucumberTestResult'](world('PENDING') as never)

        expect(result.passed).toBe(false)
        expect(result.skipped).toBe(true)
        expect(result.error).toBeUndefined()
    })

    it('keeps the real message when the result carries one', () => {
        const result = makeService(false)['_cucumberTestResult'](world('FAILED', 'AssertionError: nope') as never)

        expect(result.error?.message).toBe('AssertionError: nope')
    })

    it('falls back to Unknown Error for a message-less non-pending failure', () => {
        const result = makeService(false)['_cucumberTestResult'](world('UNDEFINED') as never)

        expect(result.error?.message).toBe('Unknown Error')
    })
})
