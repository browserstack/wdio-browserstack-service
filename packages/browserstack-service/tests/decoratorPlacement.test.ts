import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A decorator binds to the next class ELEMENT, not to the next thing that looks related. Insert a
 * method between `@PerformanceTester.Measure(..., { hookType: 'onReload' })` and `onReload` and the
 * decoration silently moves: the hook loses its telemetry, and the intruding method starts
 * reporting measurements under the hook's name.
 *
 * Nothing else in this repo can catch that. The code stays valid TypeScript, lint has no opinion,
 * and the unit suites mock `PerformanceTester.Measure` into a pass-through, so the binding has no
 * observable behaviour to assert on. Hence a structural check.
 */
const DECORATED_FILES = ['service.ts', 'launcher.ts', 'insights-handler.ts', 'accessibility-handler.ts']

describe('PerformanceTester.Measure placement', () => {
    for (const file of DECORATED_FILES) {
        it(`binds directly to a method in ${file}`, () => {
            const lines = fs.readFileSync(path.join(process.cwd(), 'src', file), 'utf8').split('\n')
            const offenders: string[] = []

            lines.forEach((line, index) => {
                if (!line.includes('@PerformanceTester.Measure')) {
                    return
                }
                // walk to the next non-blank line; that is what the decorator will attach to
                let next = index + 1
                while (next < lines.length && lines[next].trim() === '') {
                    next++
                }
                const target = lines[next]?.trim() ?? ''
                if (target.startsWith('/*') || target.startsWith('*') || target.startsWith('//')) {
                    offenders.push(`${file}:${index + 1} — decorator followed by a comment, not a method: ${target.slice(0, 60)}`)
                }
            })

            expect(offenders).toEqual([])
        })
    }
})
