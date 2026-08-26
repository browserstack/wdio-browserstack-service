import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import { extractUserHookSources, hooksUsing } from '../src/hookSources.js'

let tmpRoot: string

const write = (content: string): string => {
    const file = path.join(tmpRoot, 'wdio.conf.ts')
    fs.writeFileSync(file, content)
    return file
}

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-hooksrc-'))
})

afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('extractUserHookSources', () => {
    it('captures a function-expression hook whole', () => {
        const file = write([
            'export const config = {',
            '    before: async function () {',
            '        await browser.execute("mobile: startActivity", {})',
            '    },',
            '    specs: ["./a.js"]',
            '}'
        ].join('\n'))

        const { sources } = extractUserHookSources(file)

        expect(Object.keys(sources)).toEqual(['before'])
        expect(sources.before).toContain('mobile: startActivity')
        expect(sources.before).not.toContain('specs')
    })

    it('captures arrow and method-shorthand hooks', () => {
        const file = write([
            'export const config = {',
            '    beforeTest: (test) => { console.log(test.title) },',
            '    async afterSuite (suite) { await browser.deleteSession() }',
            '}'
        ].join('\n'))

        const { sources } = extractUserHookSources(file)

        expect(sources.beforeTest).toContain('test.title')
        expect(sources.afterSuite).toContain('deleteSession')
    })

    it('skips a typed parameter list rather than capturing the type as the body', () => {
        // `function (test: { title?: string })` — the first brace in this declaration belongs to
        // the type annotation, not the hook. Taking it captured the signature and nothing else.
        const file = write([
            'export const config = {',
            '    beforeTest: function (test: { title?: string }) {',
            '        console.log(test.title)',
            '    }',
            '}'
        ].join('\n'))

        const { sources } = extractUserHookSources(file)

        expect(sources.beforeTest).toContain('console.log(test.title)')
    })

    it('does not stop at a brace inside a string, comment or template literal', () => {
        const file = write([
            'export const config = {',
            '    before: async function () {',
            '        await $(\'//div[@id="a}b"]\').click() // a } in a comment',
            '        const q = `template } literal`',
            '        await browser.reloadSession()',
            '    }',
            '}'
        ].join('\n'))

        const { sources } = extractUserHookSources(file)

        expect(sources.before).toContain('reloadSession')
        expect(sources.before.trim().endsWith('}')).toBe(true)
    })

    it('does not let a prefix hook name match a longer one', () => {
        const file = write([
            'export const config = {',
            '    beforeTest: function () { console.log("only beforeTest here") }',
            '}'
        ].join('\n'))

        const { sources } = extractUserHookSources(file)

        expect(Object.keys(sources)).toEqual(['beforeTest'])
    })

    it('returns nothing for a config that declares no hooks, and never throws on a bad path', () => {
        expect(extractUserHookSources(write('export const config = { specs: ["./a.js"] }')).sources).toEqual({})
        expect(extractUserHookSources(path.join(tmpRoot, 'missing.conf.ts')).sources).toEqual({})
    })
})

describe('redaction of captured hook sources', () => {
    it('redacts credentials the logger\'s own scrub misses', () => {
        // BStackLogger.redactCredentials only knows user/key/userName/accessKey, so these six
        // shapes reached the uploaded log in the clear before this went through
        // redactSensitiveContent.
        const file = write([
            'export const config = {',
            '    before: async function () {',
            '        const authToken = "SENTINEL_authToken_value"',
            '        const password = "SENTINEL_password_value"',
            '        const clientSecret = "SENTINEL_clientSecret_value"',
            '        const AWS_SECRET_ACCESS_KEY = "SENTINEL_awsSecret_value"',
            '        await browser.url("https://admin:SENTINEL_userinfo@internal.corp/login")',
            '        await browser.execute("login", { token: "SENTINEL_token_value" })',
            '    }',
            '}'
        ].join('\n'))

        const { sources } = extractUserHookSources(file)

        for (const secret of ['SENTINEL_authToken_value', 'SENTINEL_password_value', 'SENTINEL_clientSecret_value', 'SENTINEL_awsSecret_value', 'SENTINEL_userinfo', 'SENTINEL_token_value']) {
            expect(sources.before).not.toContain(secret)
        }
        expect(sources.before).toContain('[REDACTED]')
    })

    it('still reports reloadSession when its line carries credentials', () => {
        // Redaction replaces the whole line, so scanning the redacted copy would lose this call.
        const file = write([
            'export const config = {',
            '    before: async function () {',
            '        await browser.reloadSession({ userName: "u", accessKey: "k" })',
            '    }',
            '}'
        ].join('\n'))

        const { sources, identifiers } = extractUserHookSources(file)

        expect(identifiers.reloadSession).toEqual(['before'])
        expect(sources.before).not.toContain('"k"')
    })
})

describe('hooksUsing', () => {
    it('reports the hooks that call the identifier', () => {
        const sources = {
            before: 'before: async function () { await browser.reloadSession() }',
            beforeTest: 'beforeTest: function () { console.log(1) }'
        }

        expect(hooksUsing(sources, 'reloadSession')).toEqual(['before'])
    })

    it('does not match the identifier as part of a longer name', () => {
        const sources = { before: 'before: function () { myReloadSessionHelper() }' }

        expect(hooksUsing(sources, 'reloadSession')).toEqual([])
    })
})
