import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'node:path'
import * as bstackLogger from '../../src/bstackLogger.js'
import WdioCucumberTestFramework from '../../src/cli/frameworks/wdioCucumberTestFramework.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

// A cwd-relative uri, as WDIO supplies it on gherkinDocument.uri.
const URI = 'features/checkout.feature'
const FEATURE = { name: 'Checkout', description: 'a feature', children: [] }

/**
 * The two path fields are deliberately different shapes and must not be conflated:
 *
 *  - `test_file_path` is ABSOLUTE. The binary re-bases it itself
 *    (`path.relative(session.pathProject, absoluteTestFilePath)` in the cucumber module), so a
 *    pre-relativised value there gets resolved against cwd first and comes out wrong (SDK-7233).
 *  - `bdd_meta_info.feature.path` is the RAW uri, matching legacy's
 *    `feature = { path: gherkinDocument.uri, … }`. Nothing in the binary's node path reads this
 *    blob, so whatever is sent reaches the dashboard verbatim — an absolute value there leaks the
 *    developer's home directory.
 */
describe('cucumber feature paths — absolute on the wire field, raw uri in the bdd meta', () => {
    let framework: WdioCucumberTestFramework

    beforeEach(() => {
        framework = new WdioCucumberTestFramework(['WebdriverIO-cucumber'], { 'WebdriverIO-cucumber': '9.0.0' }, 'bin-1')
        framework.onFeatureStart(URI, FEATURE as never)
    })

    it('sends test_file_path as an absolute path for the binary to re-base', () => {
        const featurePath = framework['featurePath']()

        expect(path.isAbsolute(featurePath as string)).toBe(true)
        expect(featurePath).toBe(path.resolve(process.cwd(), URI))
    })

    it('puts the RAW uri in bdd_meta_info.feature.path, not the absolute path', () => {
        const meta = framework['buildBddMetaInfo']({ name: 'a scenario', tags: [] } as never, FEATURE as never, [])

        expect(meta.feature.path).toBe(URI)
        expect(path.isAbsolute(meta.feature.path as string)).toBe(false)
    })

    // The regression this guards: the two fields were fed from one absolute value, so the meta
    // blob reached the dashboard carrying the developer's home directory.
    it('does not put the absolute path in the bdd meta', () => {
        const meta = framework['buildBddMetaInfo']({ name: 'a scenario', tags: [] } as never, FEATURE as never, [])

        expect(meta.feature.path).not.toBe(framework['featurePath']())
        expect(meta.feature.path).not.toContain(process.cwd())
    })
})
