import path from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))
vi.mock('fetch')
vi.mock('git-repo-info')
vi.mock('./fileStream')
vi.mock('./scripts/accessibility-scripts', () => ({
    default: {
        checkAndGetInstance: vi.fn(() => ({ update: vi.fn(), store: vi.fn() })),
        update: vi.fn(),
        store: vi.fn(),
    }
}))

import { processTestObservabilityResponse } from '../src/util.js'
import { shouldProcessEventForTesthub } from '../src/testHub/utils.js'
import { BROWSERSTACK_OBSERVABILITY, BROWSERSTACK_ACCESSIBILITY, BROWSERSTACK_PERCY } from '../src/constants.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import { CLIUtils } from '../src/cli/cliUtils.js'
import ObservabilityModule from '../src/cli/modules/observabilityModule.js'
import TestHubModule from '../src/cli/modules/testHubModule.js'

const clearProductEnv = () => {
    delete process.env[BROWSERSTACK_OBSERVABILITY]
    delete process.env[BROWSERSTACK_ACCESSIBILITY]
    delete process.env[BROWSERSTACK_PERCY]
}

// A config JSON with every apis.* key that loadModules -> updateURLSForGRR dereferences.
const CLI_CONFIG = JSON.stringify({
    apis: {
        automate: { api: 'https://api.browserstack.com', upload: 'https://api.browserstack.com' },
        appAutomate: { api: 'https://api-cloud.browserstack.com', upload: 'https://api-cloud.browserstack.com' },
        percy: { api: 'https://percy.browserstack.com' },
        appAccessibility: { api: 'https://app-a11y.browserstack.com' },
        observability: { api: 'https://collector.observability.browserstack.com', upload: 'https://upload.observability.browserstack.com' },
        edsInstrumentation: { api: 'https://eds.browserstack.com' },
    }
})

describe('CLASSIC flow: build-start observability success:false', () => {
    beforeEach(() => {
        clearProductEnv()
    })

    it('success:true -> BROWSERSTACK_OBSERVABILITY="true" and event gate is true (positive control)', () => {
        const response: any = { observability: { success: true, options: {} } }
        processTestObservabilityResponse(response)
        expect(process.env[BROWSERSTACK_OBSERVABILITY]).toEqual('true')
        expect(shouldProcessEventForTesthub('TestRunStarted')).toEqual(true)
    })

    it('success:false -> flag turned OFF ("false") AND subsequent TestHub events are suppressed', () => {
        const response: any = { observability: { success: false, errors: [{ key: 'ERROR_OBSERVABILITY_NOT_ALLOWED', message: 'unsupported framework' }] } }
        processTestObservabilityResponse(response)

        // (a) the flag IS turned off
        expect(process.env[BROWSERSTACK_OBSERVABILITY]).toEqual('false')

        // (b) a subsequent TestHub event is now suppressed (observability-only session:
        // accessibility & percy unset). Post-fix the gate reads 'false' as off.
        expect(process.env[BROWSERSTACK_ACCESSIBILITY]).toBeUndefined()
        expect(process.env[BROWSERSTACK_PERCY]).toBeUndefined()
        expect(shouldProcessEventForTesthub('TestRunStarted')).toEqual(false)
    })

    it('missing observability object -> flag "false", event gate suppressed', () => {
        const response: any = {}
        processTestObservabilityResponse(response)
        expect(process.env[BROWSERSTACK_OBSERVABILITY]).toEqual('false')
        expect(shouldProcessEventForTesthub('TestRunStarted')).toEqual(false)
    })
})

describe('CLI/gRPC flow: startBinSession observability success:false', () => {
    let instance: any

    beforeEach(() => {
        clearProductEnv()
        // Mirror launcher.ts: register the mocha/WebdriverIO framework detail so
        // loadModules -> setupTestFramework/setupAutomationFramework resolve names.
        CLIUtils.setFrameworkDetail('webdriverio-mocha', 'WebdriverIO')
        instance = BrowserstackCLI.getInstance()
        instance.modulesLoaded = false
        instance.modules = {}
        instance.binSessionId = null
        instance.config = {}
        instance.browserstackConfig = {}
        instance.options = {}
    })

    it('success:false -> ObservabilityModule NOT loaded, but TestHubModule loaded (event emission delegated to binary)', () => {
        const response: any = {
            binSessionId: 'bin-1',
            config: CLI_CONFIG,
            testhub: { jwt: 'jwt', buildHashedId: 'build-1' },
            observability: { success: false },
        }
        instance.loadModules(response)

        // observability module gated OFF by success:false
        expect(instance.modules[ObservabilityModule.MODULE_NAME]).toBeUndefined()
        expect(process.env[BROWSERSTACK_OBSERVABILITY]).not.toEqual('true')

        // BUT the event-emitting TestHubModule is loaded unconditionally whenever
        // testhub is present -- and it fires events with no observability gate.
        expect(instance.modules[TestHubModule.MODULE_NAME]).toBeDefined()

        // TestHubModule has no shouldProcessEventForTesthub-style gate: its send* paths
        // call GrpcClient unconditionally.
        const src = TestHubModule.toString() + Object.getOwnPropertyNames(TestHubModule.prototype)
            .map((m) => (TestHubModule.prototype as any)[m]?.toString?.() ?? '').join('\n')
        expect(src.includes('shouldProcessEventForTesthub')).toBe(false)
    })

    it('success:true -> ObservabilityModule loaded and BROWSERSTACK_OBSERVABILITY="true" (positive control)', () => {
        const response: any = {
            binSessionId: 'bin-2',
            config: CLI_CONFIG,
            testhub: { jwt: 'jwt', buildHashedId: 'build-2' },
            observability: { success: true, options: {} },
        }
        instance.loadModules(response)

        expect(process.env[BROWSERSTACK_OBSERVABILITY]).toEqual('true')
        expect(instance.modules[ObservabilityModule.MODULE_NAME]).toBeDefined()
        expect(instance.modules[TestHubModule.MODULE_NAME]).toBeDefined()
    })
})
