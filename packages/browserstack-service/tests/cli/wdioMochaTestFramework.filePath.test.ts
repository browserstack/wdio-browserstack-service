import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import * as bstackLogger from '../../src/bstackLogger.js'
import * as util from '../../src/util.js'

import WdioMochaTestFramework from '../../src/cli/frameworks/wdioMochaTestFramework.js'
import TestFramework from '../../src/cli/frameworks/testFramework.js'
import { TestFrameworkConstants } from '../../src/cli/frameworks/constants/testFrameworkConstants.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

// Deliberately NOT under process.cwd(), so an absolute value and a cwd-relative
// value cannot coincide and mask a regression.
const SPEC = '/Users/someone/projects/arenaclub/test/specs/smoke/homePage.test.ts'

describe('SDK-7233 — test_file_path must be the absolute spec path', () => {
    beforeEach(() => {
        vi.spyOn(TestFramework, 'getState').mockReturnValue('WebdriverIO-mocha')
        vi.spyOn(util, 'getUniqueIdentifier').mockReturnValue('Verify the homepage elements')
        vi.spyOn(util, 'getMochaTestHierarchy').mockReturnValue([])
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    // NB: not a default parameter — passing `undefined` explicitly must stay undefined.
    const getTestData = (...args: [file?: string | undefined]) =>
        getTestDataWith(args.length ? args[0] : SPEC)

    const getTestDataWith = (file: string | undefined) =>
        // @ts-expect-error — partial TestFrameworkInstance / Frameworks.Test are enough here
        WdioMochaTestFramework.prototype.getTestData.call(WdioMochaTestFramework.prototype, {}, {
            file,
            title: 'Verify the homepage elements',
            body: 'async () => {}',
        })

    it('sends the absolute path, so the binary can re-base it itself', async () => {
        // Previously this field was gated on a git root being resolvable; the
        // customer's project had none ("Unable to find a Git directory"), so it
        // went out as `undefined`, threw inside the binary, and dropped every
        // TestRunStarted/TestRunFinished event.
        const data = await getTestData()

        expect(data[TestFrameworkConstants.KEY_TEST_FILE_PATH]).toBe(SPEC)
        expect(path.isAbsolute(data[TestFrameworkConstants.KEY_TEST_FILE_PATH] as string)).toBe(true)
    })

    it('does not consult git metadata for the file path at all', async () => {
        // Re-basing is the binary's job (it holds pathProject and
        // versionControlInfo.root). The emitter must not pre-relativise, and no
        // longer pays for a git lookup per test.
        const git = vi.spyOn(util, 'getGitMetaData')

        await getTestData()

        expect(git).not.toHaveBeenCalled()
    })

    it('keeps test_location cwd-relative and distinct from test_file_path', async () => {
        const data = await getTestData()

        expect(data[TestFrameworkConstants.KEY_TEST_LOCATION]).toBe(path.relative(process.cwd(), SPEC))
        expect(data[TestFrameworkConstants.KEY_TEST_LOCATION]).not.toBe(
            data[TestFrameworkConstants.KEY_TEST_FILE_PATH],
        )
    })

    it('leaves both fields undefined when the spec filename is unknown', async () => {
        // Documented residual hole: a construct with no `test.file` still yields
        // undefined. Not reachable for normal Mocha specs, which always carry one.
        const data = await getTestData(undefined)

        expect(data[TestFrameworkConstants.KEY_TEST_FILE_PATH]).toBeUndefined()
        expect(data[TestFrameworkConstants.KEY_TEST_LOCATION]).toBeUndefined()
    })
})
