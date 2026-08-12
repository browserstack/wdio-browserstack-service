import { describe, expect, it, afterEach } from 'vitest'

import { isSensitiveKey, redactSensitiveContent, serializeConfigForLog } from '../src/configSerializer.js'
import { isAutoCaptureLogsDisabled, publishAutoCaptureDisabled } from '../src/autoCapture.js'
import { BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS } from '../src/constants.js'

afterEach(() => {
    delete process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS]
})

describe('serializeConfigForLog — recovering what JSON.stringify loses', () => {
    it('keeps hook source instead of collapsing it to null', () => {
        const config = {
            before: function () {
                const chai = require('chai')
                global.expect = chai.expect
            }
        }

        const out = JSON.parse(serializeConfigForLog(config))

        expect(out.before).toContain('chai')
        expect(out.before).not.toBe(null)
    })

    it('keeps every hook in a hook ARRAY (wdio merges hooks into arrays)', () => {
        const config = { onPrepare: [() => 'first', () => 'second'] }

        const out = JSON.parse(serializeConfigForLog(config))

        expect(out.onPrepare).toHaveLength(2)
        expect(out.onPrepare[0]).toContain('first')
        expect(out.onPrepare[1]).toContain('second')
    })

    it('keeps RegExp instead of {}', () => {
        expect(JSON.parse(serializeConfigForLog({ testMatch: /\.e2e\.ts$/ })).testMatch)
            .toBe('/\\.e2e\\.ts$/')
    })

    it('survives a circular config instead of throwing', () => {
        const config: Record<string, unknown> = { framework: 'mocha' }
        config.self = config

        expect(() => serializeConfigForLog(config)).not.toThrow()
        expect(JSON.parse(serializeConfigForLog(config)).self).toBe('[Circular]')
    })

    it('never throws on a value that cannot be serialized', () => {
        const config = { bad: { toJSON() { throw new Error('boom') } } }

        expect(() => serializeConfigForLog(config)).not.toThrow()
        expect(serializeConfigForLog(config)).toContain('[unserializable')
    })

    it('handles BigInt, Symbol and undefined without dying', () => {
        expect(() => serializeConfigForLog({ a: undefined, b: Symbol('x') })).not.toThrow()
        expect(serializeConfigForLog({ big: BigInt(1) })).toContain('[unserializable')
    })
})

describe('serializeConfigForLog — credential scrubbing', () => {
    it('redacts values under sensitive keys, including compound names', () => {
        const out = serializeConfigForLog({
            key: 'BSTACK_KEY_LEAK',
            accessKey: 'ACCESS_LEAK',
            clientSecret: 'CS_LEAK',
            client_secret: 'SNAKE_LEAK',
            CLIENT_SECRET: 'SCREAMING_LEAK',
            AWS_SECRET_ACCESS_KEY: 'AKIA_LEAK'
        })

        for (const leak of ['BSTACK_KEY_LEAK', 'ACCESS_LEAK', 'CS_LEAK', 'SNAKE_LEAK', 'SCREAMING_LEAK', 'AKIA_LEAK']) {
            expect(out).not.toContain(leak)
        }
    })

    it('redacts secrets INSIDE hook bodies — the reason serialising functions is safe', () => {
        const out = serializeConfigForLog({
            before: function () {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const apiKey = 'sk_live_HOOK_LEAK'
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const GITHUB_TOKEN = 'ghp_HOOK_LEAK'
                fetch('https://admin:hunterPASS@internal.example.com')
            }
        })

        expect(out).not.toContain('sk_live_HOOK_LEAK')
        expect(out).not.toContain('ghp_HOOK_LEAK')
        expect(out).not.toContain('hunterPASS')
        // the rest of the hook must survive, else capturing it is pointless
        expect(out).toContain('fetch')
    })

    it('redacts basic-auth in an ordinary string value', () => {
        const out = serializeConfigForLog({ baseUrl: 'https://admin:s3cr3t@example.com' })

        expect(out).not.toContain('s3cr3t')
        expect(out).toContain('example.com')
    })

    it('leaves a port-bearing URL and lookalike keys alone', () => {
        const out = serializeConfigForLog({
            baseUrl: 'https://example.com:8080/path',
            hotkey: 'ctrl+a',
            keyword: 'search',
            accessibility: true
        })

        expect(out).toContain('https://example.com:8080/path')
        expect(out).toContain('ctrl+a')
        expect(out).toContain('search')
        expect(out).toContain('"accessibility":true')
    })

    it('stays linear on pathological input (ReDoS guard)', () => {
        const started = Date.now()
        serializeConfigForLog({ baseUrl: `https://${'a'.repeat(200_000)}` })
        expect(Date.now() - started).toBeLessThan(2_000)
    })
})

describe('isSensitiveKey', () => {
    it('matches credential keys and compound forms', () => {
        for (const k of ['key', 'accessKey', 'clientSecret', 'client_secret', 'CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY']) {
            expect(isSensitiveKey(k)).toBe(true)
        }
    })

    it('does not match lookalikes', () => {
        for (const k of ['hotkey', 'keyword', 'my_secretary', 'accessibility', 'framework']) {
            expect(isSensitiveKey(k)).toBe(false)
        }
    })
})

describe('redactSensitiveContent', () => {
    it('scrubs a multi-line PEM without eating the rest', () => {
        const out = redactSensitiveContent([
            'privateKey: `-----BEGIN PRIVATE KEY-----',
            'MIIEvQIBADANsecretbytes',
            '-----END PRIVATE KEY-----`',
            'nextOption: 1'
        ].join('\n'))

        expect(out).not.toContain('MIIEvQIBADANsecretbytes')
        expect(out).toContain('nextOption')
    })
})

describe('auto-capture opt-out', () => {
    it('is off by default', () => {
        expect(isAutoCaptureLogsDisabled({})).toBe(false)
    })

    it('honours the service option and the env var', () => {
        expect(isAutoCaptureLogsDisabled({ disableAutoCaptureLogs: true })).toBe(true)
        process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS] = 'TRUE'
        expect(isAutoCaptureLogsDisabled({})).toBe(true)
    })

    it('publishes the option onto the env for the detached cleanup process', () => {
        publishAutoCaptureDisabled({ disableAutoCaptureLogs: true })
        expect(process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS]).toBe('true')
        expect(isAutoCaptureLogsDisabled()).toBe(true)
    })
})
