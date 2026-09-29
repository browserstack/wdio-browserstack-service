import path from 'node:path'

import type { Frameworks } from '@wdio/types'

import type TestFramework from './frameworks/testFramework.js'
import { TestFrameworkState } from './states/testFrameworkState.js'
import { HookState } from './states/hookState.js'
import { BStackLogger } from '../bstackLogger.js'

/**
 * Reports tests that never reach the beforeTest/afterTest lifecycle (static `it.skip`,
 * `this.skip()` inside before hooks, suites aborted by a failed before hook) through the
 * CLI gRPC tracker, so they land on the dashboard and attribute their Automate session.
 * Without this, such tests emit no events at all in the CLI flow (the legacy
 * Listener -> api/v1/batch path is dead here) and their sessions surface as
 * `session_linking_issue_build` in TRA stability.
 */

interface MochaRuntimeTest {
    title: string
    state?: string
    body?: string
    file?: string
    parent?: { title?: string, parent?: unknown, tests?: unknown[], suites?: unknown[] }
}

// tests that entered the CLI beforeTest lifecycle — those report their own finish
// (including runtime `this.skip()` inside a test body) and must not be re-reported
const startedTests = new Set<string>()
const reportedSkips = new Set<string>()
// wdio does not await reporter hooks, so back-to-back skips would interleave on the
// tracker's single mutable per-worker instance — serialize every report through one chain
let reportChain: Promise<void> = Promise.resolve()

/**
 * SDK-7493: skip reports are QUEUED here and only emitted from drainSkipReports(), never at
 * the moment onTestSkip fires.
 *
 * wdio does not await onTestSkip, so emitting inline let a skip's events interleave with a
 * live test's. Both share one per-worker tracked-instance slot, so the skip's INIT_TEST
 * repointed that slot mid-test; the live test's afterTest then restored ITS uuid onto the
 * skip's instance (service.ts `_cliTestUuids`), and from there the two tests' TEST/POSTs
 * collapsed onto one uuid — one TestRunFinished was lost (test stuck "In Progress" until the
 * ~60-min reap) and the survivor carried the wrong result. Deferring to the drain removes the
 * interleave entirely: no test is in flight there, so each skip gets its own instance and uuid.
 */
interface QueuedSkip {
    framework: TestFramework
    test: Frameworks.Test
    result: Frameworks.TestResult
    suiteTitle?: string
}
const queuedSkips: QueuedSkip[] = []

/**
 * Emit one skip's full event sequence, in order.
 *
 * Every step is attempted even if an earlier one rejects. TEST/POST is what ultimately
 * produces the TestRunFinished, and abandoning the sequence on an earlier failure is the
 * exact outcome this ticket exists to prevent: a test that is started and never finished
 * sits "In Progress" until Test Hub's ~60-min idle reap. A partial report — worse ordering,
 * a missing log payload — is strictly better than an unterminated test run.
 *
 * The first error is retained and rethrown so the caller still logs a real failure rather
 * than silently reporting success.
 */
async function emitSkipReport({ framework, test, result, suiteTitle }: QueuedSkip): Promise<void> {
    // LOG_REPORT/POST is what loads the result into the instance (loadTestResult is
    // gated on it, not on TEST/POST) — same sequence afterTest uses
    const steps: Array<[State, State, Record<string, unknown>]> = [
        [TestFrameworkState.INIT_TEST, HookState.PRE, { test }],
        [TestFrameworkState.TEST, HookState.PRE, { test, suiteTitle }],
        [TestFrameworkState.LOG_REPORT, HookState.POST, { test, result }],
        [TestFrameworkState.TEST, HookState.POST, { test, result, suiteTitle }],
    ]

    let firstError: unknown
    for (const [state, hook, args] of steps) {
        try {
            await framework.trackEvent(state, hook, args)
        } catch (err: unknown) {
            firstError ??= err
        }
    }
    if (firstError !== undefined) {
        throw firstError
    }
}

export function markTestStarted(identifier: string) {
    startedTests.add(identifier)
}

// wdio does not await the reporter's onTestSkip hook, so a static `it.skip` reported through
// reportSkippedTest can have its TEST/POST (TestRunFinished) still pending when the worker tears
// down — the test then stays "in progress" on the dashboard. The awaited after() hook drains this
// so the chain completes while the session is still open. (Hook-skip cascades go via
// reportSuiteSkipped inside afterHook, which is already awaited, so they were unaffected.)
export function drainSkipReports(): Promise<void> {
    // Emit everything queued so far, strictly one at a time. Drains until empty rather than
    // snapshotting: emitting a skip can enqueue nothing today, but draining a growing queue is
    // the safe shape. Runs from service.after(), where no test is in flight.
    reportChain = reportChain.then(async () => {
        while (queuedSkips.length > 0) {
            const queued = queuedSkips.shift()!
            try {
                await emitSkipReport(queued)
            } catch (err: unknown) {
                BStackLogger.debug(`Failed reporting skipped test '${queued.test.title}': ${err}`)
            }
        }
    })
    return reportChain
}

export function reportSkippedTest(
    framework: TestFramework,
    identifier: string,
    test: Frameworks.Test,
    suiteTitle?: string,
    options?: { immediate?: boolean }
): Promise<void> {
    if (startedTests.has(identifier) || reportedSkips.has(identifier)) {
        return reportChain
    }
    reportedSkips.add(identifier)
    const result = { passed: false, skipped: true } as Frameworks.TestResult
    const queued: QueuedSkip = { framework, test, result, suiteTitle }

    // SDK-7493: only the DETACHED caller needs deferring. `immediate` is for callers wdio
    // awaits — the hook cascade (afterHook) and the bail cascade (afterTest). Those never had
    // the interleave, because wdio holds the lifecycle open until they resolve, so nothing else
    // can claim the tracked slot underneath them. Deferring those too would be a behaviour
    // change for no benefit: their skips would move to end-of-run and their reports would no
    // longer be part of the hook/test they belong to.
    if (options?.immediate) {
        reportChain = reportChain.then(() => emitSkipReport(queued)).catch((err: unknown) => {
            BStackLogger.debug(`Failed reporting skipped test '${identifier}': ${err}`)
        })
        return reportChain
    }

    // The un-awaited `onTestSkip` path: queue it — see the QueuedSkip docs above. Emitting here
    // would interleave this skip's events with whatever test is currently running.
    //
    // Tradeoff: delivery now depends on service.after() running. If the worker dies before it
    // (SIGKILL, OOM, a teardown error that skips after()), queued skips are dropped with no
    // send attempted, where the old inline path would at least have tried. Accepted because
    // the inline path is the bug being fixed, and an aborted worker already leaves its
    // in-progress test runs to Test Hub's idle reap regardless.
    queuedSkips.push(queued)
    return reportChain
}

/**
 * Port of the legacy insights-handler skip propagation: when a BEFORE_ALL/BEFORE_EACH/
 * AFTER_EACH hook fails (or skips), mocha silently drops the remaining tests in the
 * suite — report each state-undefined test as skipped, recursing into nested describes.
 *
 * Reports IMMEDIATELY (SDK-7493): every caller of this — the failed-hook cascade in
 * `afterHook` and the bail cascade in `afterTest` — is awaited by wdio, so these reports
 * cannot interleave with a live test the way the un-awaited `onTestSkip` path could. They
 * belong to the hook/test being reported, so they must not slide to end-of-run.
 */
export async function reportSuiteSkipped(framework: TestFramework, suite: { tests?: unknown[], suites?: unknown[] }): Promise<void> {
    for (const t of (suite.tests || []) as MochaRuntimeTest[]) {
        if (t.state !== undefined) {
            continue
        }
        const parentTitle = t.parent?.title ?? ''
        const identifier = `${parentTitle} - ${t.title}`
        // keep `parent` a string (the Automate session name interpolates it) and pass the
        // real suite chain via ctx for scope/hierarchy extraction; `file` must resolve or
        // the binary drops the event on path.relative(cwd, undefined)
        const synthetic = {
            title: t.title,
            parent: parentTitle,
            body: t.body || '',
            file: t.file,
            ctx: { test: { parent: t.parent } }
        } as unknown as Frameworks.Test
        await reportSkippedTest(framework, identifier, synthetic, parentTitle, { immediate: true })
    }
    for (const sub of (suite.suites || []) as { tests?: unknown[], suites?: unknown[] }[]) {
        await reportSuiteSkipped(framework, sub)
    }
}

/** Resolve a spec file path usable by the binary (it rejects events with no location). */
export function resolveSpecFile(candidate: string | undefined, runnerSpec: string | undefined): string | undefined {
    if (candidate) {
        return candidate
    }
    if (runnerSpec) {
        return runnerSpec.startsWith('file://') ? runnerSpec.replace(/^file:\/\//, '') : path.resolve(runnerSpec)
    }
    return undefined
}
