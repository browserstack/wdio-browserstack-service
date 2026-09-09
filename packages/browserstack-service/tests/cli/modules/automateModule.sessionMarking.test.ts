import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import AutomateModule from '../../../src/cli/modules/automateModule.js'
import TestFramework from '../../../src/cli/frameworks/testFramework.js'
import AutomationFramework from '../../../src/cli/frameworks/automationFramework.js'
import { TestFrameworkConstants } from '../../../src/cli/frameworks/constants/testFrameworkConstants.js'
import { _fetch as fetch } from '../../../src/fetchWrapper.js'
import type { Options } from '@wdio/types'

vi.mock('../../../src/cli/frameworks/testFramework.js', () => ({
    default: {
        registerObserver: vi.fn(),
        setState: vi.fn(),
        getState: vi.fn(),
        getTrackedInstance: vi.fn()
    }
}))

vi.mock('../../../src/cli/frameworks/automationFramework.js', () => ({
    default: {
        getTrackedInstance: vi.fn(),
        getState: vi.fn(),
        getDriver: vi.fn()
    }
}))

vi.mock('../../../src/cli/cliLogger.js', () => ({
    BStackLogger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }
}))

vi.mock('../../../src/util.js', () => ({
    isBrowserstackSession: vi.fn(() => true),
    isTrue: vi.fn((value) => (value + '').toLowerCase() === 'true'),
    hasAppCap: vi.fn(() => false)
}))

vi.mock('../../../src/instrumentation/performance/performance-tester.js', () => ({
    default: { measureWrapper: vi.fn((event, fn) => fn) }
}))

vi.mock('../../../src/fetchWrapper.js', () => ({ _fetch: vi.fn() }))

const cucumberInstance = { framework: 'WebdriverIO-cucumber' }
const mochaInstance = { framework: 'WebdriverIO-mocha' }

function stateFor(instance: unknown, key: string) {
    if (key === TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME) {
        return (instance as { framework: string }).framework
    }
    if (key === TestFrameworkConstants.KEY_HOOKS_FINISHED) {
        return new Map([['BEFORE_ALL', [{ [TestFrameworkConstants.KEY_HOOK_NAME]: 'BEFORE_ALL for Login' }]]])
    }
    return undefined
}

function newModule(config: Record<string, unknown> = {}) {
    const mod = new AutomateModule({ user: 'u', key: 'k' } as Options.Testrunner)
    mod.config = {
        testContextOptions: { skipSessionName: false, skipSessionStatus: false },
        userName: 'testuser',
        accessKey: 'testkey',
        ...config
    } as never
    return mod
}

describe('AutomateModule — session marking', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue({} as never)
        vi.mocked(AutomationFramework.getState).mockImplementation((_i, key) =>
            key === 'framework_session_id' ? 'sess-1' : ({} as never))
        vi.mocked(TestFramework.getState).mockImplementation((instance, key) => stateFor(instance, key))
        vi.mocked(fetch).mockResolvedValue({ json: async () => ({ ok: true }) } as never)
        delete process.env.BROWSERSTACK_TURBOSCALE_INTERNAL
    })

    afterEach(() => {
        delete process.env.BROWSERSTACK_TURBOSCALE_INTERNAL
    })

    /**
     * Discriminating: the SAME call produces opposite verbs and different hosts/paths
     * depending only on the turboscale flag.
     */
    describe('turboscale session marking routes to its own API with PATCH', () => {
        it('PATCHes the turboscale endpoint when turboScale is configured', async () => {
            const mod = newModule({ turboScale: true })
            await mod.markSessionStatus('sess-1', 'passed', undefined, { user: 'u', key: 'k' })

            const [url, options] = vi.mocked(fetch).mock.calls[0]
            expect(url).toBe('https://api.browserstack.com/automate-turboscale/v1/sessions/sess-1.json')
            expect((options as { method: string }).method).toBe('PATCH')
        })

        it('PUTs the automate endpoint when turboScale is not configured', async () => {
            const mod = newModule()
            await mod.markSessionStatus('sess-1', 'passed', undefined, { user: 'u', key: 'k' })

            const [url, options] = vi.mocked(fetch).mock.calls[0]
            expect(url).toBe('https://api.browserstack.com/automate/sessions/sess-1.json')
            expect((options as { method: string }).method).toBe('PUT')
        })

        it('honours the BROWSERSTACK_TURBOSCALE_INTERNAL fallback', async () => {
            process.env.BROWSERSTACK_TURBOSCALE_INTERNAL = 'true'
            const mod = newModule()
            await mod.markSessionName('sess-1', 'a name', { user: 'u', key: 'k' })

            const [url, options] = vi.mocked(fetch).mock.calls[0]
            expect(url).toContain('/automate-turboscale/v1/sessions/')
            expect((options as { method: string }).method).toBe('PATCH')
        })

        it('takes precedence over app-automate, mirroring legacy assignment order', async () => {
            const mod = newModule({ turboScale: true, app: 'bs://app' })
            await mod.markSessionStatus('sess-1', 'failed', 'boom', { user: 'u', key: 'k' })

            expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/automate-turboscale/v1/sessions/')
        })

        it('names and statuses agree on verb and path', async () => {
            const mod = newModule({ turboScale: true })
            await mod.markSessionName('sess-1', 'a name', { user: 'u', key: 'k' })
            await mod.markSessionStatus('sess-1', 'passed', undefined, { user: 'u', key: 'k' })

            const [nameUrl, nameOpts] = vi.mocked(fetch).mock.calls[0]
            const [statusUrl, statusOpts] = vi.mocked(fetch).mock.calls[1]
            expect(nameUrl).toBe(statusUrl)
            expect((nameOpts as { method: string }).method).toBe((statusOpts as { method: string }).method)
        })
    })

    /**
     * Session verdict. Discriminating: the SAME failing build-level hook fails the session
     * for cucumber and leaves mocha's verdict untouched.
     */
    describe('build-level hook failures reach the session verdict', () => {
        const failing = { passed: false, error: new Error('BeforeAll blew up') }

        /** Drives one scenario through TEST/POST so `testResults` carries a real scenario result. */
        const runScenario = (mod: AutomateModule, passed: boolean) => mod.onAfterTest({
            instance: cucumberInstance,
            result: { error: passed ? null : new Error('step failed'), passed },
            test: { title: 'a scenario', fullName: 'Feature: a scenario' },
            suiteTitle: 'Feature'
        })

        const statusBody = () => {
            const call = vi.mocked(fetch).mock.calls.find(([, o]) =>
                JSON.parse((o as { body: string }).body).status !== undefined)
            return call ? JSON.parse((call[1] as { body: string }).body) : undefined
        }

        it('marks the session failed for cucumber when a BeforeAll fails', async () => {
            const mod = newModule()
            await mod.onBuildLevelHookEnd('BEFORE_ALL', { instance: cucumberInstance, result: failing })
            await mod.onAfterExecute()

            const statusCall = vi.mocked(fetch).mock.calls.find(([, o]) =>
                JSON.parse((o as { body: string }).body).status !== undefined)!
            const body = JSON.parse((statusCall[1] as { body: string }).body)
            expect(body.status).toBe('failed')
            expect(body.reason).toBe('BeforeAll blew up')
        })

        it('names the hook in the failure reason', async () => {
            const mod = newModule()
            await mod.onBuildLevelHookEnd('BEFORE_ALL', { instance: cucumberInstance, result: failing })
            await mod.onBuildLevelHookEnd('AFTER_ALL', { instance: cucumberInstance, result: { passed: false, error: new Error('teardown') } })
            await mod.onAfterExecute()

            const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as { body: string }).body)
            expect(body.reason).toContain('BEFORE_ALL for Login')
        })

        it('leaves wdio_mocha untouched — the identical failure records nothing', async () => {
            const mod = newModule()
            await mod.onBuildLevelHookEnd('BEFORE_ALL', { instance: mochaInstance, result: failing })
            await mod.onAfterExecute()

            expect(fetch).not.toHaveBeenCalled()
        })

        it('records nothing when the hook passed', async () => {
            const mod = newModule()
            await mod.onBuildLevelHookEnd('BEFORE_ALL', { instance: cucumberInstance, result: { passed: true } })
            await mod.onAfterExecute()

            expect(fetch).not.toHaveBeenCalled()
        })

        it('keeps the session PASSED under ignoreHooksStatus once a scenario has run', async () => {
            const mod = newModule()
            await runScenario(mod, true)
            await mod.onBuildLevelHookEnd('AFTER_ALL', {
                instance: cucumberInstance,
                result: failing,
                ignoreHooksStatus: true
            })
            await mod.onAfterExecute()

            expect(statusBody()).toEqual({ status: 'passed' })
        })

        /**
         * Zero scenarios is legacy's `!_specsRan` arm, which marks failed with no regard for the
         * flag. Discriminating against the case directly above: identical hook, identical flag,
         * opposite verdicts — the scenario having run is the only difference.
         */
        it('marks the session FAILED under ignoreHooksStatus when no scenario ran', async () => {
            const mod = newModule()
            await mod.onBuildLevelHookEnd('BEFORE_ALL', {
                instance: cucumberInstance,
                result: failing,
                ignoreHooksStatus: true
            })
            await mod.onAfterExecute()

            expect(statusBody().status).toBe('failed')
        })

        it('leaves wdio_mocha unmarked on that same zero-scenario case', async () => {
            const mod = newModule()
            await mod.onBuildLevelHookEnd('BEFORE_ALL', {
                instance: mochaInstance,
                result: failing,
                ignoreHooksStatus: true
            })
            await mod.onAfterExecute()

            expect(fetch).not.toHaveBeenCalled()
        })

        it('does not fail a session whose scenarios all passed and whose hooks all passed', async () => {
            const mod = newModule()
            await runScenario(mod, true)
            await mod.onBuildLevelHookEnd('AFTER_ALL', { instance: cucumberInstance, result: { passed: true } })
            await mod.onAfterExecute()

            expect(statusBody()).toEqual({ status: 'passed' })
        })

        it('respects skipSessionStatus', async () => {
            const mod = newModule({ testContextOptions: { skipSessionName: false, skipSessionStatus: true } })
            await mod.onBuildLevelHookEnd('BEFORE_ALL', { instance: cucumberInstance, result: failing })
            await mod.onAfterExecute()

            expect(fetch).not.toHaveBeenCalled()
        })

        it('does not rename the session when the hook failure is the only record', async () => {
            const mod = newModule()
            await mod.onBuildLevelHookEnd('BEFORE_ALL', { instance: cucumberInstance, result: failing })
            await mod.onAfterExecute()

            const bodies = vi.mocked(fetch).mock.calls.map(([, o]) => JSON.parse((o as { body: string }).body))
            expect(bodies.some(b => b.name !== undefined)).toBe(false)
        })
    })
})
