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
 * So the service registers a finisher per running test in `beforeTest`; whichever comes first —
 * `afterTest` (normal case) or the reporter's `onTestFail` (timeout case) — claims it and reports
 * the finish exactly once. `after()` awaits any finish the reporter started.
 */
type CliTestFinisher = (result: Frameworks.TestResult) => Promise<void>

const finishers = new Map<string, CliTestFinisher>()
/** Tests the reporter already finished; their late afterTest must not report them again. */
const reportedOnFailure = new Set<string>()
const inFlight = new Set<Promise<void>>()

/** beforeTest: this test's finish is now owed, by afterTest or by the reporter. */
export function registerCliTestFinisher(identifier: string, finisher: CliTestFinisher): void {
    finishers.set(identifier, finisher)
}

/**
 * afterTest: claim the finish. Returns false only when the reporter already reported it (the
 * test timed out), in which case afterTest must not report it again. A test that was never
 * registered still belongs to afterTest.
 */
export function claimCliTestFinish(identifier: string): boolean {
    finishers.delete(identifier)
    return !reportedOnFailure.delete(identifier)
}

/**
 * Reporter `onTestFail`: if afterTest has not reported this test yet, report its failure now,
 * from mocha's own result. Returns whether a finish was started.
 */
export function finishCliTestOnFailure(identifier: string, result: Frameworks.TestResult): boolean {
    const finisher = finishers.get(identifier)
    if (!finisher) {
        return false
    }
    finishers.delete(identifier)
    reportedOnFailure.add(identifier)
    BStackLogger.debug(`finishCliTestOnFailure: mocha reported '${identifier}' failed before its afterTest; reporting the finish now`)
    const work = finisher(result).catch((err: unknown) => {
        BStackLogger.debug(`finishCliTestOnFailure: reporting '${identifier}' failed: ${util.format(err)}`)
    })
    inFlight.add(work)
    work.finally(() => inFlight.delete(work))
    return true
}

/** after(): wait for finishes the reporter started, before the session status and the flush. */
export async function awaitCliTestFinishesOnFailure(): Promise<void> {
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
