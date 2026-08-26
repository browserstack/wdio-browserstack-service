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

        const sources = extractUserHookSources(file)

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

        const sources = extractUserHookSources(file)

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

        const sources = extractUserHookSources(file)

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

        const sources = extractUserHookSources(file)

        expect(sources.before).toContain('reloadSession')
        expect(sources.before.trim().endsWith('}')).toBe(true)
    })

    it('does not let a prefix hook name match a longer one', () => {
        const file = write([
            'export const config = {',
            '    beforeTest: function () { console.log("only beforeTest here") }',
            '}'
        ].join('\n'))

        const sources = extractUserHookSources(file)

        expect(Object.keys(sources)).toEqual(['beforeTest'])
    })

    it('returns nothing for a config that declares no hooks, and never throws on a bad path', () => {
        expect(extractUserHookSources(write('export const config = { specs: ["./a.js"] }'))).toEqual({})
        expect(extractUserHookSources(path.join(tmpRoot, 'missing.conf.ts'))).toEqual({})
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
