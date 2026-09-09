import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import BrowserstackService from '../src/service.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import WdioCucumberTestFramework from '../src/cli/frameworks/wdioCucumberTestFramework.js'

vi.mock('../src/cli/index.js', () => ({
    BrowserstackCLI: {
        getInstance: () => ({
            isRunning: () => false,
            getTestFramework: () => null,
            getAutomationFramework: () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) })
        })
    }
}))

/**
 * The seam between the two halves of automateModule decides the rename (it is the
 * only place that knows the final scenario count), but it cannot read service options, so the flag
 * rides the scenario event — the same route `ignoreHooksStatus` takes. The decision itself is
 * covered in tests/cli/modules/automateModule.preferScenarioName.test.ts.
 */
describe('preferScenarioName reaches the module', () => {
    let getInstanceSpy: ReturnType<typeof vi.spyOn> | undefined
    let trackEvent: ReturnType<typeof vi.fn>

    const makeService = (options: Record<string, unknown> = {}) => new BrowserstackService(
        { testObservability: false, setSessionName: true, setSessionStatus: true, ...options } as never,
        [] as never,
        { user: 'foo', key: 'bar', framework: 'cucumber', cucumberOpts: { strict: false } } as never
    )

    const scenarioEventArgs = () => trackEvent.mock.calls.at(-1)?.[2] as Record<string, unknown>

    beforeEach(() => {
        trackEvent = vi.fn().mockResolvedValue(undefined)
        const cucumberFramework = Object.create(WdioCucumberTestFramework.prototype)
        cucumberFramework.trackEvent = trackEvent
        cucumberFramework.hasStepFailures = () => false
        getInstanceSpy = vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({
            isRunning: () => true,
            getTestFramework: () => cucumberFramework,
            getAutomationFramework: () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) })
        } as never)
    })

    afterEach(() => {
        getInstanceSpy?.mockRestore()
    })

    it('carries preferScenarioName: true on the scenario event when set', async () => {
        const service = makeService({ preferScenarioName: true })
        await service.afterScenario({ pickle: { name: 'Can do something single' }, result: { status: 'passed' } } as never)

        expect(scenarioEventArgs().preferScenarioName).toBe(true)
    })

    // Absent must travel as an explicit false, not undefined: the module treats the field as the
    // whole opt-in, so a missing value and an opted-out value must be indistinguishable there.
    it('carries preferScenarioName: false when the option is absent', async () => {
        const service = makeService()
        await service.afterScenario({ pickle: { name: 'Can do something single' }, result: { status: 'passed' } } as never)

        expect(scenarioEventArgs().preferScenarioName).toBe(false)
    })

    // The count itself stays on the service side too, because `_scenariosRanCount` is what legacy
    // reads; the module keeps its own tally for the CLI flow. Both must ignore skipped scenarios.
    it('does not count a skipped scenario toward the service-side tally', async () => {
        const service = makeService({ preferScenarioName: true })
        await service.afterScenario({ pickle: { name: 'Skipped one' }, result: { status: 'skipped' } } as never)

        expect(service['_scenariosRanCount']).toBe(0)
    })
})

describe('_cucumberTestResult failure reason adjacent', () => {
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
