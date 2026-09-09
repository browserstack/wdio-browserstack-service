import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import BrowserstackService from '../src/service.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import { AutomationFrameworkState } from '../src/cli/states/automationFrameworkState.js'
import { HookState } from '../src/cli/states/hookState.js'

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
 * The CREATE/POST event is the driver registration — `webdriverIOModule.onDriverCreated` and the
 * other product modules' init handlers all hang off it. It used to be raised ONLY inside
 * `if (shouldProcessEventForTesthub(''))`, which is a disjunction over the three product flags: with
 * every product off the gate closes, the event never fires, and the session goes unnamed and
 * unmarked while `browser.setCustomTags` is never defined.
 *
 * Both assertions matter. The first is the fix. The second is the safety property of its shape —
 * it must not double-raise on the configurations that already worked.
 */
describe('driver registration is not gated on observability', () => {
    const PRODUCT_ENV = ['BROWSERSTACK_OBSERVABILITY', 'BROWSERSTACK_ACCESSIBILITY', 'BROWSERSTACK_PERCY']
    let trackEvent: ReturnType<typeof vi.fn>
    let getInstanceSpy: ReturnType<typeof vi.spyOn> | undefined
    const saved: Record<string, string | undefined> = {}

    const createPostCalls = () => trackEvent.mock.calls.filter(
        ([state, hook]) => state === AutomationFrameworkState.CREATE && hook === HookState.POST)

    const runBefore = async () => {
        const service = new BrowserstackService({} as never, [{}] as never, { capabilities: {} } as never)
        await service.beforeSession({} as never)
        await service.before(service['_config'] as never, [], { sessionId: 'sess-1' } as never)
    }

    beforeEach(() => {
        PRODUCT_ENV.forEach(k => { saved[k] = process.env[k]; delete process.env[k] })
        trackEvent = vi.fn().mockResolvedValue(undefined)
        getInstanceSpy = vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({
            isRunning: () => true,
            getTestFramework: () => null,
            getAutomationFramework: () => ({ trackEvent }),
            modules: {}
        } as never)
    })

    afterEach(() => {
        PRODUCT_ENV.forEach(k => { if (saved[k] === undefined) { delete process.env[k] } else { process.env[k] = saved[k] } })
        getInstanceSpy?.mockRestore()
    })

    // The fix: every product off is the one configuration that closes the gate.
    it('registers the driver with every product turned off', async () => {
        await runBefore()

        expect(createPostCalls()).toHaveLength(1)
    })

    // The safety property: on a configuration that already worked, the event must fire once, not
    // twice — the gated block still raises it and this must not add a second.
    it('does not double-register when observability is on', async () => {
        process.env.BROWSERSTACK_OBSERVABILITY = 'true'

        await runBefore()

        expect(createPostCalls()).toHaveLength(1)
    })

    // Accessibility alone also holds the gate open, so the same single-fire rule applies.
    it('does not double-register when only accessibility is on', async () => {
        process.env.BROWSERSTACK_ACCESSIBILITY = 'true'

        await runBefore()

        expect(createPostCalls()).toHaveLength(1)
    })
})
