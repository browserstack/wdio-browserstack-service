import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'node:path'
import * as bstackLogger from '../../src/bstackLogger.js'
import WdioCucumberTestFramework from '../../src/cli/frameworks/wdioCucumberTestFramework.js'
import { TestFrameworkState } from '../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../src/cli/states/hookState.js'
import { TestFrameworkConstants } from '../../src/cli/frameworks/constants/testFrameworkConstants.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

const RELATIVE_URI = 'features/checkout.feature'
const ABSOLUTE_URI = path.resolve(process.cwd(), RELATIVE_URI)
const FEATURE = { name: 'Checkout', description: 'a feature', children: [] }

/**
 * The two path fields are deliberately different shapes and must not be conflated:
 *
 *  - `test_file_path` is ABSOLUTE. The binary re-bases it itself
 *    (`path.relative(session.pathProject, absoluteTestFilePath)` in the cucumber module), so a
 *    pre-relativised value there gets resolved against cwd first and comes out wrong (SDK-7233).
 *  - `bdd_meta_info.feature.path` is cwd-relative, matching legacy's
 *    `feature = { path: gherkinDocument.uri, … }`. Nothing in the binary's node path reads this
 *    blob, so whatever is sent reaches the dashboard verbatim — an absolute value there leaks the
 *    developer's home directory.
 *
 * Both uri shapes are exercised because WDIO hands `beforeFeature` the ABSOLUTE one. A fixture that
 * only feeds the relative shape stays green against a `path` that forwards the uri raw, which is
 * exactly how an absolute path reached the dashboard under a passing suite.
 */
describe.each([
    ['a relative uri', RELATIVE_URI],
    ['the absolute uri WDIO supplies', ABSOLUTE_URI],
])('cucumber feature paths — %s', (_shape, uri) => {
    let framework: WdioCucumberTestFramework

    beforeEach(() => {
        framework = new WdioCucumberTestFramework(['WebdriverIO-cucumber'], { 'WebdriverIO-cucumber': '9.0.0' }, 'bin-1')
        framework.onFeatureStart(uri, FEATURE as never)
    })

    it('sends test_file_path as an absolute path for the binary to re-base', () => {
        const featurePath = framework['featurePath']()

        expect(path.isAbsolute(featurePath as string)).toBe(true)
        expect(featurePath).toBe(ABSOLUTE_URI)
    })

    it('puts a cwd-relative path in bdd_meta_info.feature.path', () => {
        const meta = framework['buildBddMetaInfo']({ name: 'a scenario', tags: [] } as never, FEATURE as never, [])

        expect(meta.feature.path).toBe(RELATIVE_URI)
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

describe('scenario end — stamped after the TEST/POST observers', () => {
    let framework: WdioCucumberTestFramework
    let order: string[]
    let instance: { updateMultipleEntries: ReturnType<typeof vi.fn> }

    beforeEach(() => {
        framework = new WdioCucumberTestFramework(['WebdriverIO-cucumber'], { 'WebdriverIO-cucumber': '9.0.0' }, 'bin-1')
        order = []
        instance = {
            updateMultipleEntries: vi.fn((entries: Record<string, unknown>) => {
                if (TestFrameworkConstants.KEY_TEST_ENDED_AT in entries) {
                    order.push('ended_at')
                }
            })
        }
        framework['resolveInstance'] = vi.fn(() => instance) as never
        framework['loadScenarioResult'] = vi.fn() as never
    })

    it('restamps ended_at after the observers, then releases the held finish', async () => {
        const runHooks = vi.fn(async (_i: unknown, _s: unknown, _h: unknown, args: Record<string, unknown>) => {
            order.push(args.holdFinishUntilHooksEnd === true ? 'observers(hold)' : 'observers')
            args.releaseHeldFinish = async () => {
                order.push('release')
            }
        })
        framework.runHooks = runHooks as never

        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, {})

        expect(order).toEqual(['ended_at', 'observers(hold)', 'ended_at', 'release'])
    })

    it('still restamps and releases when an observer throws', async () => {
        framework.runHooks = vi.fn(async (_i: unknown, _s: unknown, _h: unknown, args: Record<string, unknown>) => {
            args.releaseHeldFinish = async () => {
                order.push('release')
            }
            throw new Error('observer failed')
        }) as never

        await expect(framework.trackEvent(TestFrameworkState.TEST, HookState.POST, {})).rejects.toThrow('observer failed')
        expect(order).toEqual(['ended_at', 'ended_at', 'release'])
    })

    it('does not hold or restamp for other states', async () => {
        const runHooks = vi.fn(async () => {})
        framework.runHooks = runHooks as never
        const args: Record<string, unknown> = {}

        await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, args)

        expect(args.holdFinishUntilHooksEnd).toBeUndefined()
        expect(order).toEqual([])
    })
})
