import { describe, expect, it, beforeEach } from 'vitest'

import APIUtils from '../../src/cli/apiUtils.js'

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
    EDS_URL: 'https://eds.browserstack.com'
} as const

describe('APIUtils.updateURLSForGRR', () => {
    beforeEach(() => {
        Object.assign(APIUtils, DEFAULTS)
    })

    it('overlays every endpoint from a complete GRR config', () => {
        APIUtils.updateURLSForGRR({
            automate: { api: 'https://grr-automate', upload: 'https://grr-automate-upload' },
            appAutomate: { api: 'https://grr-aa', upload: 'https://grr-aa-upload' },
            percy: { api: 'https://grr-percy' },
            appAccessibility: { api: 'https://grr-app-a11y' },
            observability: { api: 'https://grr-o11y', upload: 'https://grr-o11y-upload' },
            edsInstrumentation: { api: 'https://grr-eds' }
        } as never)

        expect(APIUtils.FUNNEL_INSTRUMENTATION_URL).toBe('https://grr-automate/sdk/v1/event')
        expect(APIUtils.BROWSERSTACK_AUTOMATE_API_URL).toBe('https://grr-automate')
        expect(APIUtils.BROWSERSTACK_AUTOMATE_API_CLOUD_URL).toBe('https://grr-automate-upload')
        expect(APIUtils.BROWSERSTACK_AA_API_URL).toBe('https://grr-aa')
        expect(APIUtils.BROWSERSTACK_AA_API_CLOUD_URL).toBe('https://grr-aa-upload')
        expect(APIUtils.BROWSERSTACK_PERCY_API_URL).toBe('https://grr-percy')
        expect(APIUtils.APP_ALLY_ENDPOINT).toBe('https://grr-app-a11y/automate')
        expect(APIUtils.DATA_ENDPOINT).toBe('https://grr-o11y')
        expect(APIUtils.UPLOAD_LOGS_ADDRESS).toBe('https://grr-o11y-upload')
        expect(APIUtils.EDS_URL).toBe('https://grr-eds')
    })

    // SDK-7138: a degenerate bin-session config used to throw here and abort the whole
    // CLI bootstrap, taking every product module down with it.
    it.each([
        ['undefined', undefined],
        ['an empty object', {}]
    ])('keeps the public defaults and does not throw for %s', (_label, apis) => {
        expect(() => APIUtils.updateURLSForGRR(apis as never)).not.toThrow()
        expect(APIUtils.BROWSERSTACK_AUTOMATE_API_URL).toBe(DEFAULTS.BROWSERSTACK_AUTOMATE_API_URL)
        expect(APIUtils.DATA_ENDPOINT).toBe(DEFAULTS.DATA_ENDPOINT)
    })

    it('applies the entries a partial config does carry and leaves the rest default', () => {
        APIUtils.updateURLSForGRR({ observability: { api: 'https://grr-o11y' } } as never)

        expect(APIUtils.DATA_ENDPOINT).toBe('https://grr-o11y')
        expect(APIUtils.UPLOAD_LOGS_ADDRESS).toBe(DEFAULTS.UPLOAD_LOGS_ADDRESS)
        expect(APIUtils.BROWSERSTACK_AUTOMATE_API_URL).toBe(DEFAULTS.BROWSERSTACK_AUTOMATE_API_URL)
    })
})
