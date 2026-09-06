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

function register(mod: AutomateModule, sessionId: string, lastTestName: string, appliedName?: string) {
    const sessionMap = mod['sessionMap'] as Map<string, { lastTestName: string, appliedName?: string, testResults: Map<string, unknown> }>
    sessionMap.set(sessionId, { lastTestName, appliedName, testResults: new Map() })
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

describe('AutomateModule.overrideSessionName — parity row 40 (preferScenarioName)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue({} as never)
        vi.mocked(AutomationFramework.getState).mockImplementation((_i, key) =>
            key === 'framework_session_id' ? 'sess-1' : ({} as never))
        vi.mocked(fetch).mockResolvedValue({ json: async () => ({ ok: true }) } as never)
    })

    it('renames a registered session to the scenario name', async () => {
        const mod = newModule()
        register(mod, 'sess-1', 'Login Feature', 'Login Feature')

        await mod.overrideSessionName('Can do something single')

        expect(namesPUT()).toContain('Can do something single')
        expect(mod['sessionMap'].get('sess-1')!.lastTestName).toBe('Can do something single')
    })

    // The rename is the same opt-out legacy applies: service.after() omits `name` from its
    // _updateJob payload when setSessionName is false, so the override must not sneak one in.
    it('honours setSessionName: false and issues no rename', async () => {
        const mod = newModule({ testContextOptions: { skipSessionName: true, skipSessionStatus: false } })
        register(mod, 'sess-1', 'Login Feature', 'Login Feature')

        await mod.overrideSessionName('Can do something single')

        expect(fetch).not.toHaveBeenCalled()
        expect(mod['sessionMap'].get('sess-1')!.lastTestName).toBe('Login Feature')
    })

    it('no-ops when the session was never registered', async () => {
        const mod = newModule()

        await mod.overrideSessionName('Can do something single')

        expect(fetch).not.toHaveBeenCalled()
    })

    it('no-ops when no session id resolves', async () => {
        const mod = newModule()
        register(mod, 'sess-1', 'Login Feature', 'Login Feature')
        vi.mocked(AutomationFramework.getState).mockReturnValue(undefined as never)

        await mod.overrideSessionName('Can do something single')

        expect(fetch).not.toHaveBeenCalled()
    })

    it('no-ops on an empty name', async () => {
        const mod = newModule()
        register(mod, 'sess-1', 'Login Feature', 'Login Feature')

        await mod.overrideSessionName('')

        expect(fetch).not.toHaveBeenCalled()
        expect(mod['sessionMap'].get('sess-1')!.lastTestName).toBe('Login Feature')
    })

    it('costs no API call when the override matches the name already applied', async () => {
        const mod = newModule()
        register(mod, 'sess-1', 'Can do something single', 'Can do something single')

        await mod.overrideSessionName('Can do something single')

        expect(fetch).not.toHaveBeenCalled()
    })
})
