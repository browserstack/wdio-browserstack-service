import path from 'node:path'

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Frameworks } from '@wdio/types'

vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))

import { markTestStarted, reportSkippedTest, reportSuiteSkipped, resolveSpecFile } from '../../src/cli/skipReporter.js'
import { TestFrameworkState } from '../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../src/cli/states/hookState.js'
import type TestFramework from '../../src/cli/frameworks/testFramework.js'

const makeFramework = () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }) as unknown as TestFramework

const makeTest = (title: string, parent = 'suite') => ({ title, parent }) as unknown as Frameworks.Test

describe('skipReporter', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('reports a skipped test through the INIT_TEST/TEST/LOG_REPORT sequence', async () => {
        const framework = makeFramework()
        await reportSkippedTest(framework, 'suite - reports once', makeTest('reports once'), 'suite')

        const calls = vi.mocked(framework.trackEvent).mock.calls
        expect(calls.map(([state, hook]) => [state, hook])).toEqual([
            [TestFrameworkState.INIT_TEST, HookState.PRE],
            [TestFrameworkState.TEST, HookState.PRE],
            [TestFrameworkState.LOG_REPORT, HookState.POST],
            [TestFrameworkState.TEST, HookState.POST],
        ])
        expect(calls[2][2]).toMatchObject({ result: { passed: false, skipped: true } })
    })

    it('does not re-report the same identifier', async () => {
        const framework = makeFramework()
        await reportSkippedTest(framework, 'suite - dedup', makeTest('dedup'), 'suite')
        await reportSkippedTest(framework, 'suite - dedup', makeTest('dedup'), 'suite')
        expect(framework.trackEvent).toHaveBeenCalledTimes(4)
    })

    it('does not report tests that entered the beforeTest lifecycle', async () => {
        const framework = makeFramework()
        markTestStarted('suite - runtime skip')
        await reportSkippedTest(framework, 'suite - runtime skip', makeTest('runtime skip'), 'suite')
        expect(framework.trackEvent).not.toHaveBeenCalled()
    })

    it('serializes concurrent reports through one chain', async () => {
        const order: string[] = []
        const framework = {
            trackEvent: vi.fn().mockImplementation(async (_s: unknown, _h: unknown, args: { test: { title: string } }) => {
                order.push(args.test.title)
                await new Promise(resolve => setTimeout(resolve, 1))
            })
        } as unknown as TestFramework

        await Promise.all([
            reportSkippedTest(framework, 'suite - first', makeTest('first'), 'suite'),
            reportSkippedTest(framework, 'suite - second', makeTest('second'), 'suite'),
        ])
        expect(order).toEqual(['first', 'first', 'first', 'first', 'second', 'second', 'second', 'second'])
    })

    it('walks nested suites and skips already-determined tests', async () => {
        const framework = makeFramework()
        const parent = { title: 'outer' }
        const suite = {
            tests: [
                { title: 'ran already', state: 'passed', parent },
                { title: 'undetermined', parent, file: '/spec/a.spec.js' },
            ],
            suites: [{
                tests: [{ title: 'nested undetermined', parent: { title: 'inner' } }],
                suites: [],
            }],
        }
        await reportSuiteSkipped(framework, suite)
        // 2 undetermined tests x 4 tracker events
        expect(framework.trackEvent).toHaveBeenCalledTimes(8)
        const reported = vi.mocked(framework.trackEvent).mock.calls
            .filter(([state]) => state === TestFrameworkState.INIT_TEST)
            .map(([, , args]) => (args as { test: { title: string } }).test.title)
        expect(reported).toEqual(['undetermined', 'nested undetermined'])
    })

    it('resolves spec file from the runner spec when the test has none', () => {
        expect(resolveSpecFile('/abs/spec.js', 'file:///runner/spec.js')).toBe('/abs/spec.js')
        expect(resolveSpecFile(undefined, 'file:///runner/spec.js')).toBe('/runner/spec.js')
        expect(resolveSpecFile(undefined, undefined)).toBeUndefined()
    })
})
