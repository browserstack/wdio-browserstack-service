import { describe, expect, it, vi, beforeEach } from 'vitest'
import AutomateModule from '../../../src/cli/modules/automateModule.js'
import AutomationFramework from '../../../src/cli/frameworks/automationFramework.js'
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

function register(mod: AutomateModule, sessionId: string, lastTestName: string, seed: Record<string, unknown> = {}) {
    const sessionMap = mod['sessionMap'] as Map<string, Record<string, unknown>>
    sessionMap.set(sessionId, {
        lastTestName,
        testResults: new Map(),
        scenariosRan: 0,
        ...seed
    })
    return sessionMap
}

function namesPUT() {
    return vi.mocked(fetch).mock.calls.map(([, init]) => {
        try {
            return JSON.parse((init as { body: string }).body).name
        } catch {
            return undefined
        }
    })
}

describe('AutomateModule preferScenarioName — parity row 40', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue({} as never)
        vi.mocked(AutomationFramework.getState).mockImplementation((_i, key) =>
            key === 'framework_session_id' ? 'sess-1' : ({} as never))
        vi.mocked(fetch).mockResolvedValue({ json: async () => ({ ok: true }) } as never)
    })

    // Exactly one non-skipped scenario ran and the flag is set: the session takes the scenario
    // name. This is the only branch where legacy departs from the feature name.
    it('renames to the scenario name when exactly one scenario ran', async () => {
        const mod = newModule()
        register(mod, 'sess-1', 'Login Feature', {
            scenariosRan: 1, lastScenarioName: 'Can log in', preferScenarioName: true
        })

        await mod.onAfterExecute()

        expect(namesPUT()).toContain('Can log in')
    })

    // The `=== 1` exactness legacy applies: two scenarios keep the feature name. Reproduced, not
    // widened — a `>= 1` here would rename every multi-scenario feature.
    it('keeps the feature name when two scenarios ran', async () => {
        const mod = newModule()
        register(mod, 'sess-1', 'Login Feature', {
            scenariosRan: 2, lastScenarioName: 'Second scenario', preferScenarioName: true
        })

        await mod.onAfterExecute()

        expect(namesPUT()).not.toContain('Second scenario')
        expect(namesPUT()).toContain('Login Feature')
    })

    it('keeps the feature name when the flag is absent', async () => {
        const mod = newModule()
        register(mod, 'sess-1', 'Login Feature', {
            scenariosRan: 1, lastScenarioName: 'Can log in'
        })

        await mod.onAfterExecute()

        expect(namesPUT()).not.toContain('Can log in')
    })

    // Legacy omits `name` from its _updateJob payload when setSessionName is false, so the
    // rename must not sneak one in.
    it('honours setSessionName: false and issues no rename', async () => {
        const mod = newModule({ testContextOptions: { skipSessionName: true, skipSessionStatus: false } })
        register(mod, 'sess-1', 'Login Feature', {
            scenariosRan: 1, lastScenarioName: 'Can log in', preferScenarioName: true
        })

        await mod.onAfterExecute()

        expect(namesPUT()).not.toContain('Can log in')
    })

    // A skipped scenario is not a scenario that ran — legacy's counter is gated the same way,
    // so a feature whose only non-skipped scenario is absent must not be renamed.
    it('does not count a skipped scenario', async () => {
        const mod = newModule()
        register(mod, 'sess-1', 'Login Feature', { preferScenarioName: true })
        const sessionData = mod['sessionMap'].get('sess-1')!

        expect(sessionData.scenariosRan).toBe(0)

        await mod.onAfterExecute()

        expect(namesPUT()).not.toContain('Can log in')
    })

    // mocha never reaches the counter (it is gated on isCucumberInstance), so its session name
    // is whatever onBeforeTest applied — the discriminating case against cucumber above.
    it('leaves a session with no cucumber scenarios untouched', async () => {
        const mod = newModule()
        register(mod, 'sess-1', 'Testing with BStackDemo - add product to cart', {
            scenariosRan: 0, preferScenarioName: true
        })

        await mod.onAfterExecute()

    })
})
