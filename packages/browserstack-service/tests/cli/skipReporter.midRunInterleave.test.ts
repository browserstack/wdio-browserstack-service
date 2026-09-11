import path from 'node:path'

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Frameworks } from '@wdio/types'

vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))

import { drainSkipReports, reportSkippedTest } from '../../src/cli/skipReporter.js'
import { TestFrameworkState } from '../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../src/cli/states/hookState.js'
import type TestFramework from '../../src/cli/frameworks/testFramework.js'

const makeTest = (title: string, parent = 'Test A') => ({ title, parent }) as unknown as Frameworks.Test

/**
 * SDK-7493 — a skipped test in the MIDDLE of a spec was left rendering "In Progress".
 *
 * Customer shape (SDK-7493 comment 2359027), still failing on 9.35.3:
 *
 *     it('TC-5944 Test 1')        // runs
 *     it.skip('TC-5947 Test 2')   // skipped, in the middle
 *     it('TC-5948 Test 3')        // runs
 *
 * wdio does not await `onTestSkip`, so emitting the skip's events inline let them interleave
 * with Test 3's. Both tests resolve through ONE per-worker tracked-instance slot, so the
 * skip's INIT_TEST repointed that slot mid-test; Test 3's afterTest then restored ITS uuid
 * onto the skip's instance (`service.ts` `_cliTestUuids`), and from there both tests' TEST/POSTs
 * collapsed onto a single uuid — Test 2's TestRunFinished was never sent (stuck "In Progress"
 * until Test Hub's ~60-min idle reap) and Test 3 was closed with the skip's result.
 *
 * The fix is that a skip report never fires while a test is in flight: it is queued and emitted
 * only from `drainSkipReports()`, which `service.after()` calls with no test running.
 */
describe('skipReporter — a skip must not interleave with a running test (SDK-7493)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('emits nothing at report time — the events are queued, not fired inline', async () => {
        const framework = { trackEvent: vi.fn().mockResolvedValue(undefined) } as unknown as TestFramework

        await reportSkippedTest(framework, 'Test A - TC-5947 Test 2', makeTest('TC-5947 Test 2'), 'Test A')

        // The whole defect was these landing mid-test. Nothing may reach the tracker yet.
        expect(framework.trackEvent).not.toHaveBeenCalled()

        await drainSkipReports()
        expect(framework.trackEvent).toHaveBeenCalledTimes(4)
    })

    it('does not touch the tracker while a test is mid-flight, and still delivers on drain', async () => {
        const events: string[] = []
        const framework = {
            trackEvent: vi.fn().mockImplementation(async (state: unknown, hook: unknown, args: { test?: { title: string } }) => {
                const shortState = String(state).split('.')[1]
                const shortHook = String(hook).split('.')[1]
                events.push(`${args?.test?.title ?? '?'}:${shortState}/${shortHook}`)
            })
        } as unknown as TestFramework

        // Test 3 is "running": its INIT_TEST/TEST-PRE have fired and its afterTest has not yet.
        await framework.trackEvent(TestFrameworkState.INIT_TEST, HookState.PRE, { test: makeTest('TC-5948 Test 3') })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { test: makeTest('TC-5948 Test 3') })

        // wdio fires onTestSkip for the middle test right here, un-awaited.
        void reportSkippedTest(framework, 'Test A - TC-5947 Test 2 (interleave)', makeTest('TC-5947 Test 2'), 'Test A')
        await Promise.resolve()

        // Test 3 finishes. Nothing from the skip may appear between its PRE and its POST —
        // that interleave is what hijacked the tracked slot and lost a TestRunFinished.
        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test: makeTest('TC-5948 Test 3') })

        expect(events).toEqual([
            'TC-5948 Test 3:INIT_TEST/PRE',
            'TC-5948 Test 3:TEST/PRE',
            'TC-5948 Test 3:TEST/POST',
        ])

        // service.after() drains — now, with no test in flight, the skip reports itself in full.
        await drainSkipReports()
        expect(events.slice(3)).toEqual([
            'TC-5947 Test 2:INIT_TEST/PRE',
            'TC-5947 Test 2:TEST/PRE',
            'TC-5947 Test 2:LOG_REPORT/POST',
            'TC-5947 Test 2:TEST/POST',
        ])
    })

    it('still attempts TEST/POST when an earlier lifecycle event rejects', async () => {
        // TEST/POST is what produces the TestRunFinished. Bailing out of the sequence on an
        // earlier failure would leave the test started-but-never-finished — i.e. "In Progress"
        // until the ~60-min reap, which is the whole defect this ticket is about.
        const seen: string[] = []
        const framework = {
            trackEvent: vi.fn().mockImplementation(async (state: unknown, hook: unknown) => {
                const name = `${String(state).split('.')[1]}/${String(hook).split('.')[1]}`
                seen.push(name)
                if (name === 'TEST/PRE') {
                    throw new Error('transport blip on TEST/PRE')
                }
            })
        } as unknown as TestFramework

        void reportSkippedTest(framework, 'Test A - rejects midway', makeTest('rejects midway'), 'Test A')
        await drainSkipReports()

        // every step attempted, in order, despite the rejection in the middle
        expect(seen).toEqual([
            'INIT_TEST/PRE',
            'TEST/PRE',
            'LOG_REPORT/POST',
            'TEST/POST',
        ])
    })

    it('delivers every queued skip — none is dropped when several queue up', async () => {
        const framework = { trackEvent: vi.fn().mockResolvedValue(undefined) } as unknown as TestFramework

        for (const title of ['skip one', 'skip two', 'skip three']) {
            void reportSkippedTest(framework, `Test A - ${title}`, makeTest(title), 'Test A')
        }
        await drainSkipReports()

        const started = vi.mocked(framework.trackEvent).mock.calls
            .filter(([state]) => state === TestFrameworkState.INIT_TEST)
            .map(([, , args]) => (args as { test: { title: string } }).test.title)
        const finished = vi.mocked(framework.trackEvent).mock.calls
            .filter(([state, hook]) => state === TestFrameworkState.TEST && hook === HookState.POST)
            .map(([, , args]) => (args as { test: { title: string } }).test.title)

        // A TestRunStarted with no TestRunFinished is exactly what leaves a test "In Progress".
        expect(started).toEqual(['skip one', 'skip two', 'skip three'])
        expect(finished).toEqual(started)
    })
})
