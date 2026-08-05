import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { collect, enumerateSpecs } from '../../src/testOps/specEnumerator.js'
import type { EnumeratedTest, MochaSuite } from '../../src/testOps/specEnumerator.js'

// Mirrors the shape mocha builds during its declaration pass: nested suites, `fullTitle()`
// on each test. Verified against real mocha end-to-end; kept as a fixture here because mocha
// is the user's dependency, not the SDK's.
const mochaShapedSuite = (): MochaSuite => ({
    title: '',
    tests: [],
    suites: [
        {
            title: 'Suite A',
            tests: [
                { title: 'A1', file: '/spec/a.js', fullTitle: () => 'Suite A A1' },
                { title: 'A2', file: '/spec/a.js', fullTitle: () => 'Suite A A2' }
            ],
            suites: [
                {
                    title: 'Nested',
                    tests: [{ title: 'N1', file: '/spec/a.js', fullTitle: () => 'Suite A Nested N1' }],
                    suites: []
                }
            ]
        },
        {
            title: 'Suite B',
            tests: [{ title: 'B1', file: '/spec/a.js', fullTitle: () => 'Suite B B1' }],
            suites: []
        }
    ]
})

describe('specEnumerator.collect', () => {
    it('walks nested and sibling suites, recording scopes outermost-first', () => {
        const out: EnumeratedTest[] = []
        collect(mochaShapedSuite(), '/spec/a.js', [], out)

        expect(out.map(t => t.fullTitle)).toEqual([
            'Suite A A1',
            'Suite A A2',
            'Suite A Nested N1',
            'Suite B B1'
        ])
        expect(out.find(t => t.title === 'N1')?.scopes).toEqual(['Suite A', 'Nested'])
        // sibling top-level describe is reached — the case bail must not miss
        expect(out.find(t => t.title === 'B1')?.scopes).toEqual(['Suite B'])
    })

    it('falls back to title when a test has no fullTitle fn, and to the spec file when unset', () => {
        const out: EnumeratedTest[] = []
        collect(
            { title: '', tests: [{ title: 'bare' }], suites: [] },
            '/spec/fallback.js',
            [],
            out
        )

        expect(out).toHaveLength(1)
        expect(out[0].fullTitle).toBe('bare')
        expect(out[0].file).toBe('/spec/fallback.js')
    })

    it('tolerates suites with no tests or suites arrays', () => {
        const out: EnumeratedTest[] = []
        collect({ title: 'empty' } as MochaSuite, '/spec/e.js', [], out)
        expect(out).toEqual([])
    })
})

describe('specEnumerator.enumerateSpecs', () => {
    it('returns empty for no specs', async () => {
        expect(await enumerateSpecs([])).toEqual([])
    })

    it('degrades to empty rather than throwing when a spec cannot be loaded', async () => {
        // instrumentation must never break the user's run
        await expect(enumerateSpecs(['/spec/does-not-exist.js'])).resolves.toEqual([])
    })
})

describe('specEnumerator.enumerateSpecs against real mocha', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk7063-'))
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

    const write = (name: string, body: string) => {
        const file = path.join(dir, name)
        fs.writeFileSync(file, body)
        return file
    }

    it('enumerates declared tests without executing their bodies', async () => {
        // `browser` is undefined here — if a body ran, this would throw
        const spec = write('basic.spec.cjs', `
            describe('Outer', () => {
                it('T1', async () => { await browser.url('x') })
                describe('Inner', () => {
                    it('T2', async () => { await browser.url('x') })
                })
            })
            describe('Sibling', () => {
                it('T3', async () => { await browser.url('x') })
            })
        `)

        const found = await enumerateSpecs([spec])

        expect(found.map(t => t.fullTitle)).toEqual(['Outer T1', 'Outer Inner T2', 'Sibling T3'])
        expect(found.find(t => t.title === 'T2')?.scopes).toEqual(['Outer', 'Inner'])
        expect(found.every(t => t.file === spec)).toBe(true)
    })

    it('enumerates loop-generated tests — the case static parsing would miss', async () => {
        const spec = write('dynamic.spec.cjs', `
            describe('Generated', () => {
                for (let i = 1; i <= 3; i++) {
                    it('case ' + i, async () => { await browser.url('x') })
                }
            })
        `)

        const found = await enumerateSpecs([spec])

        expect(found.map(t => t.fullTitle)).toEqual([
            'Generated case 1', 'Generated case 2', 'Generated case 3'
        ])
    })

    it('keeps enumerating other specs when one fails to load', async () => {
        // one Mocha instance per spec, so a throwing file must not poison the rest
        const bad = write('broken.spec.cjs', 'throw new Error("boom at load time")')
        const good = write('good.spec.cjs', "describe('Fine', () => { it('OK', () => {}) })")

        const found = await enumerateSpecs([bad, good])

        expect(found.map(t => t.fullTitle)).toEqual(['Fine OK'])
    })
})
