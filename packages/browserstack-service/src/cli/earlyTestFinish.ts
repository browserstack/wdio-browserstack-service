import util from 'node:util'
import type { Frameworks } from '@wdio/types'

import { BStackLogger } from '../bstackLogger.js'

/**
 * SDK-7843: finish a mocha test on the CLI flow at the moment mocha reports it failed.
 *
 * wdio runs a test's `afterTest` hook inside the test's own runnable, after the body. When the
 * test hits mocha's timeout, mocha marks it failed (and emits `fail` to reporters) while the body
 * and its `afterTest` are still pending. With `bail`, or when it was the worker's last test, wdio
 * then runs `after()` BEFORE that `afterTest` fires, so everything `after()` does on the CLI flow
 * runs without the failure: the session status is marked `passed`, and the test's TestRunFinished
 * is stranded until Test Hub reaps the build as `timeout`. The classic flow never had this, because
 * it reads the session status from `after(result)` — mocha's own failure count.
 *
 * So the service registers a finisher per running test attempt in `beforeTest`; whichever comes
 * first — `afterTest` (normal case) or the reporter's `onTestFail` (timeout case) — claims it and
 * reports the finish exactly once. The reporter is only registered when Test Hub events are on, so
 * `after()` also finishes any test mocha already failed that nobody claimed, from mocha's own
 * runnable, and then awaits every finish started here.
 */
type CliTestFinisher = (result: Frameworks.TestResult) => Promise<void>

/** The live mocha runnable of an attempt; mocha sets `state` before it emits `fail`. */
interface MochaRunnable {
    state?: string
    timedOut?: boolean
    duration?: number
    timeout?: () => number
}

const finishers = new Map<string, { finisher: CliTestFinisher, runnable?: MochaRunnable }>()
/** Attempts the reporter already finished; their late afterTest must not report them again. */
const reportedOnFailure = new Set<string>()
const inFlight = new Set<Promise<void>>()

/**
 * Key one attempt of a test. With mocha retries, a timed-out attempt's late afterTest can arrive
 * while the next attempt of the same test is running, so the hand-off must not be shared between
 * attempts. The service reads the attempt from mocha's `_currentRetry`, the reporter from
 * `TestStats.retries`; both count retries of this test so far.
 */
export function cliTestAttemptKey(identifier: string, attempt?: number): string {
    return attempt ? `${identifier} (retry ${attempt})` : identifier
}

/** beforeTest: this attempt's finish is now owed, by afterTest or by the reporter. */
export function registerCliTestFinisher(key: string, finisher: CliTestFinisher, runnable?: MochaRunnable): void {
    finishers.set(key, { finisher, runnable })
}

/** The failure mocha recorded on an attempt's runnable (it keeps no error object on it). */
function failureFromRunnable(runnable: MochaRunnable): Frameworks.TestResult {
    const ms = typeof runnable.timeout === 'function' ? runnable.timeout() : undefined
    const error = new Error(runnable.timedOut && ms ? `Timeout of ${ms}ms exceeded.` : 'Test failed before its afterTest ran.')
    return { passed: false, error, duration: runnable.duration ?? 0, retries: { attempts: 0, limit: 0 }, exception: error.message, status: 'failed' }
}

/**
 * afterTest: claim the finish. Returns false when the attempt is reported on failure instead —
 * already by the reporter, or now, because mocha already failed it (a timed-out test whose body
 * finished late, with no reporter registered). wdio's result for such a body says only whether
 * the body threw, not that mocha timed it out. In both cases afterTest must not report it.
 * A normal failure is untouched: its afterTest runs before mocha marks the runnable failed.
 * A test that was never registered still belongs to afterTest.
 */
export function claimCliTestFinish(key: string): boolean {
    const runnable = finishers.get(key)?.runnable
    if (runnable?.state === 'failed') {
        finishCliTestOnFailure(key, failureFromRunnable(runnable))
    }
    finishers.delete(key)
    return !reportedOnFailure.delete(key)
}

/**
 * Reporter `onTestFail`: if afterTest has not reported this attempt yet, report its failure now,
 * from mocha's own result. Returns whether a finish was started.
 */
export function finishCliTestOnFailure(key: string, result: Frameworks.TestResult): boolean {
    const entry = finishers.get(key)
    if (!entry) {
        return false
    }
    finishers.delete(key)
    reportedOnFailure.add(key)
    BStackLogger.debug(`finishCliTestOnFailure: mocha reported '${key}' failed before its afterTest; reporting the finish now`)
    const work = entry.finisher(result).catch((err: unknown) => {
        BStackLogger.debug(`finishCliTestOnFailure: reporting '${key}' failed: ${util.format(err)}`)
    })
    inFlight.add(work)
    work.finally(() => inFlight.delete(work))
    return true
}

/**
 * after(): finish every attempt mocha already failed that neither afterTest nor the reporter
 * claimed (no reporter registered), then wait for all finishes started on failure. Runs before
 * the deferred-finish flush and before the session status is marked.
 */
export async function awaitCliTestFinishesOnFailure(): Promise<void> {
    for (const [key, { runnable }] of [...finishers]) {
        if (runnable?.state === 'failed') {
            finishCliTestOnFailure(key, failureFromRunnable(runnable))
        }
    }
    while (inFlight.size > 0) {
        await Promise.all([...inFlight])
    }
}

/** Test-only reset of the module state. */
export function resetCliTestFinishers(): void {
    finishers.clear()
    reportedOnFailure.clear()
    inFlight.clear()
}
