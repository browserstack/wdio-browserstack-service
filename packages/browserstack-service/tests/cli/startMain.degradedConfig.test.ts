/**
 * SDK-7337 — end-to-end mechanism test at the level that actually failed in production.
 *
 * Production build vtd7gusdrthd24zcnfbvav1vqyoajdta83narfv5:
 *   binary: "Central Auth Server returned non 2xx, triggering fallback HTTP Basic"
 *   => the binary's DESIGNED fallback returns a config with no `apis` key
 *   => loadModules() threw TypeError at APIUtils.updateURLSForGRR
 *   => isMainConnected was never set  (startMain :121 throws before :122)
 *   => isRunning() false at launcher.ts:436 => a SECOND, phantom TestHub build
 *
 * The property that actually prevents the phantom is `isMainConnected === true`
 * after startMain() with a degenerate config. That is what this pins — the
 * apiUtils unit test only covers the leaf function.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as bstackLogger from '../../src/bstackLogger.js'
import { BStackLogger } from '../../src/cli/cliLogger.js'
import { BrowserstackCLI } from '../../src/cli/index.js'
import { GrpcClient } from '../../src/cli/grpcClient.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

// The exact shape the binary returns after the central-auth 401 fallback:
// a valid session + a real testhub build, but NO `apis` key in config.
const DEGRADED_RESPONSE = {
    binSessionId: '2c7ec879-6361-480b-ae1a-80f3cdb7b98e',
    config: JSON.stringify({
        userName: '****', accessKey: '****',
        platforms: [{ platformName: 'android', deviceName: 'Samsung Galaxy S24' }],
        testObservability: true,
        // NOTE: no `apis` — this is the production degenerate config
    }),
    testhub: { buildHashedId: 'nv0422be6czlfoupoaexhbxktfhnzwahkmujaeua' },
}

describe('SDK-7337 startMain() with the 401-degraded (apis-less) binary config', () => {
    let instance: any

    beforeEach(() => {
        instance = BrowserstackCLI.getInstance()
        vi.spyOn(BStackLogger, 'error').mockImplementation(() => {})
        vi.spyOn(BStackLogger, 'debug').mockImplementation(() => {})
        vi.spyOn(BStackLogger, 'info').mockImplementation(() => {})
        vi.spyOn(BStackLogger, 'warn').mockImplementation(() => {})
        // start() spawns the real binary — stub it; the session is already "up".
        vi.spyOn(instance, 'start').mockResolvedValue(undefined as never)
        vi.spyOn(GrpcClient, 'getInstance').mockReturnValue({
            startBinSession: vi.fn().mockResolvedValue(DEGRADED_RESPONSE),
        } as never)
        instance.isMainConnected = false
        instance.isChildConnected = false
        instance.modulesLoaded = false
        instance.config = {}
        instance.modules = {}
        instance.wdioConfig = {}
        // Framework detail is resolved during framework DETECTION, from an env var or a
        // value set by CLIUtils.setFrameworkDetail — never from `config`, and therefore
        // wholly unaffected by the 401 (verified: getTestFrameworkDetail touches neither
        // `config` nor `apis`). Supplying the production values keeps the single variable
        // under test the missing `apis`, rather than this harness's lack of a WDIO project.
        process.env.BROWSERSTACK_TEST_FRAMEWORK_DETAIL =
            JSON.stringify({ name: 'WebdriverIO-mocha', version: '9.36.1' })
        process.env.BROWSERSTACK_AUTOMATION_FRAMEWORK_DETAIL =
            JSON.stringify({ name: 'WebdriverIO', version: '9.36.1' })
    })

    afterEach(() => {
        vi.restoreAllMocks()
        instance.isMainConnected = false
        instance.modulesLoaded = false
        instance.config = {}
        instance.modules = {}
        delete process.env.BROWSERSTACK_TEST_FRAMEWORK_DETAIL
        delete process.env.BROWSERSTACK_AUTOMATION_FRAMEWORK_DETAIL
    })

    it('startMain() does not throw on an apis-less config', async () => {
        await expect(instance.startMain()).resolves.not.toThrow()
    })

    it('sets isMainConnected = true — THE property that prevents the phantom build', async () => {
        await instance.startMain()
        expect(instance.isMainConnected).toBe(true)
    })

    it('publishes the REAL build uuid to BROWSERSTACK_TESTHUB_UUID (not a phantom)', async () => {
        delete process.env.BROWSERSTACK_TESTHUB_UUID
        await instance.startMain()
        expect(process.env.BROWSERSTACK_TESTHUB_UUID)
            .toBe('nv0422be6czlfoupoaexhbxktfhnzwahkmujaeua')
    })

    it('warns that GRR URLs are incomplete — the degradation is not silent', async () => {
        await instance.startMain()
        const warned = (BStackLogger.warn as unknown as { mock: { calls: string[][] } }).mock.calls
            .some(c => String(c[0]).includes('GRR URLs incomplete'))
        expect(warned).toBe(true)
    })
})
