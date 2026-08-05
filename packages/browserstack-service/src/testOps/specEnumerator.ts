import path from 'node:path'
import { createRequire } from 'node:module'

import { BStackLogger } from '../bstackLogger.js'

/**
 * Enumerates the tests declared in a spec file WITHOUT running them, so tests that never
 * execute (mocha `bail` aborting a spec, wdio `bail` dropping whole spec files) can still be
 * reported as skipped instead of vanishing from the run.
 *
 * Mocha builds its full suite tree during the declaration pass, before executing anything, so
 * loading a file is enough to learn every test in it. Test bodies are never invoked — only the
 * file's top level and its `describe` callbacks run. That is also the limitation: a spec whose
 * top level performs real side effects will perform them again here.
 *
 * Loop-generated tests are covered, which is why this loads rather than statically parsing.
 */

export interface EnumeratedTest {
    /** `describe > nested describe > test` joined as mocha's fullTitle */
    fullTitle: string
    title: string
    /** titles of the enclosing suites, outermost first */
    scopes: string[]
    file: string
}

/**
 * mocha is the user's dependency, not ours — resolve it from their project, never from the
 * SDK's own tree.
 */
function loadMocha(cwd: string) {
    try {
        return createRequire(path.join(cwd, 'noop.js'))('mocha')
    } catch (err) {
        BStackLogger.debug(`specEnumerator: mocha not resolvable from ${cwd}: ${err}`)
        return null
    }
}

/** Exported for tests: mocha is the user's dependency, so the walk is verified against a
 *  mocha-shaped fixture here and against real mocha end-to-end. */
export function collect(suite: MochaSuite, file: string, scopes: string[], out: EnumeratedTest[]) {
    for (const test of suite.tests || []) {
        out.push({
            fullTitle: typeof test.fullTitle === 'function' ? test.fullTitle() : test.title,
            title: test.title,
            scopes: [...scopes],
            file: test.file || file
        })
    }
    for (const child of suite.suites || []) {
        collect(child, file, [...scopes, child.title], out)
    }
}

export interface MochaSuite {
    title: string
    tests?: { title: string, file?: string, fullTitle?: () => string }[]
    suites?: MochaSuite[]
}

/**
 * @returns every test declared across `specs`, or an empty array if enumeration is not possible.
 *          Never throws — a failure here must not break the user's run.
 */
export async function enumerateSpecs(specs: string[], cwd: string = process.cwd()): Promise<EnumeratedTest[]> {
    if (!specs?.length) {
        return []
    }
    const Mocha = loadMocha(cwd)
    if (!Mocha) {
        return []
    }

    const found: EnumeratedTest[] = []
    for (const spec of specs) {
        const file = spec.startsWith('file://') ? spec.replace(/^file:\/\//, '') : spec
        try {
            // one instance per spec so a file that throws cannot poison the others
            const mocha = new Mocha({ ui: 'bdd', reporter: 'min' })
            mocha.addFile(file)
            await mocha.loadFilesAsync()
            collect(mocha.suite as MochaSuite, file, [], found)
        } catch (err) {
            BStackLogger.debug(`specEnumerator: could not enumerate ${file}: ${err}`)
        }
    }
    return found
}
