/**
 * SDK-7337 — the binary's `build/start` can return 401, after which the config it
 * hands back to the SDK carries no `apis` key. Production build
 * vtd7gusdrthd24zcnfbvav1vqyoajdta83narfv5 then threw
 *   TypeError: Cannot read properties of undefined (reading 'automate')
 * inside loadModules(), aborting bootstrap so the launcher started a SECOND,
 * duplicate TestHub build.
 *
 * The guard asserted here is NOT new: it is `3befc20` (LCAM-1282), shipped in
 * @wdio/browserstack-service@8.51.0 on the v8 line and never forward-ported to
 * main. These tests pin the v8 contract so the port cannot silently drift:
 *   - all-or-nothing (a partial map keeps EVERY default — never a mixed
 *     GRR/prod endpoint set, which is the routing hazard the v8 guard exists to
 *     prevent)
 *   - warns with the missing-key list (the only signal left that auth degraded:
 *     logBuildErrors emits nothing in the 401 case)
 *   - returns boolean so callers can branch
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import APIUtils from '../../src/cli/apiUtils.js'
import { BStackLogger } from '../../src/cli/cliLogger.js'

const DEFAULTS = {
    FUNNEL_INSTRUMENTATION_URL: 'https://api.browserstack.com/sdk/v1/event',
    BROWSERSTACK_AUTOMATE_API_URL: 'https://api.browserstack.com',
    BROWSERSTACK_AA_API_URL: 'https://api.browserstack.com',
    BROWSERSTACK_PERCY_API_URL: 'https://api.browserstack.com',
    BROWSERSTACK_AUTOMATE_API_CLOUD_URL: 'https://api-cloud.browserstack.com',
    BROWSERSTACK_AA_API_CLOUD_URL: 'https://api-cloud.browserstack.com',
    APP_ALLY_ENDPOINT: 'https://app-accessibility.browserstack.com/automate',
    DATA_ENDPOINT: 'https://collector-observability.browserstack.com',
    UPLOAD_LOGS_ADDRESS: 'https://upload-observability.browserstack.com',
    EDS_URL: 'https://eds.browserstack.com',
}

const FULL_GRR = {
    automate: { hub: 'h', cdp: 'c', api: 'https://a.grr', upload: 'https://a.up' },
    appAutomate: { hub: 'h', cdp: 'c', api: 'https://aa.grr', upload: 'https://aa.up' },
    percy: { api: 'https://p.grr' },
    appAccessibility: { api: 'https://aac.grr' },
    observability: { api: 'https://o.grr', upload: 'https://o.up' },
    edsInstrumentation: { api: 'https://eds.grr' },
}

describe('SDK-7337 APIUtils.updateURLSForGRR — degenerate config after binary auth failure', () => {
    beforeEach(() => {
        Object.assign(APIUtils, DEFAULTS)
        vi.spyOn(BStackLogger, 'warn').mockImplementation(() => {})
    })
    afterEach(() => vi.restoreAllMocks())

    it('does not throw when the binary returned no `apis` key (the production 401 case)', () => {
        expect(() => APIUtils.updateURLSForGRR(undefined)).not.toThrow()
    })

    it('returns false and keeps EVERY production default when `apis` is absent', () => {
        expect(APIUtils.updateURLSForGRR(undefined)).toBe(false)
        for (const [k, v] of Object.entries(DEFAULTS)) {
            expect(APIUtils[k as keyof typeof DEFAULTS]).toBe(v)
        }
    })

    it('is ALL-OR-NOTHING on a partial map — never mixes GRR and prod endpoints', () => {
        const partial = { automate: { hub: 'h', cdp: 'c', api: 'https://a.grr', upload: 'https://a.up' } }
        expect(APIUtils.updateURLSForGRR(partial as never)).toBe(false)
        // the present key must NOT be applied: a split endpoint set is the routing
        // hazard 3befc20 exists to prevent
        expect(APIUtils.BROWSERSTACK_AUTOMATE_API_URL).toBe(DEFAULTS.BROWSERSTACK_AUTOMATE_API_URL)
        expect(APIUtils.DATA_ENDPOINT).toBe(DEFAULTS.DATA_ENDPOINT)
    })

    it('warns with the missing keys — the only remaining signal that auth degraded', () => {
        APIUtils.updateURLSForGRR(undefined)
        expect(BStackLogger.warn).toHaveBeenCalledTimes(1)
        const msg = (BStackLogger.warn as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]
        expect(msg).toContain('GRR URLs incomplete')
        expect(msg).toContain('automate.api')
        expect(msg).toContain('edsInstrumentation.api')
    })

    it('missingGRRUrlKeys lists exactly the absent keys', () => {
        expect(APIUtils.missingGRRUrlKeys(FULL_GRR as never)).toEqual([])
        expect(APIUtils.missingGRRUrlKeys(undefined)).toHaveLength(9)
    })

    it('STILL applies every GRR override when the full apis map is present (no regression)', () => {
        expect(APIUtils.updateURLSForGRR(FULL_GRR as never)).toBe(true)
        expect(APIUtils.FUNNEL_INSTRUMENTATION_URL).toBe('https://a.grr/sdk/v1/event')
        expect(APIUtils.BROWSERSTACK_AUTOMATE_API_URL).toBe('https://a.grr')
        expect(APIUtils.BROWSERSTACK_AA_API_URL).toBe('https://aa.grr')
        expect(APIUtils.BROWSERSTACK_PERCY_API_URL).toBe('https://p.grr')
        expect(APIUtils.BROWSERSTACK_AUTOMATE_API_CLOUD_URL).toBe('https://a.up')
        expect(APIUtils.BROWSERSTACK_AA_API_CLOUD_URL).toBe('https://aa.up')
        expect(APIUtils.APP_ALLY_ENDPOINT).toBe('https://aac.grr/automate')
        expect(APIUtils.DATA_ENDPOINT).toBe('https://o.grr')
        expect(APIUtils.UPLOAD_LOGS_ADDRESS).toBe('https://o.up')
        expect(APIUtils.EDS_URL).toBe('https://eds.grr')
        expect(BStackLogger.warn).not.toHaveBeenCalled()
    })
})
