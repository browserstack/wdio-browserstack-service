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

export function markTestStarted(identifier: string) {
    startedTests.add(identifier)
}

// wdio does not await the reporter's onTestSkip hook, so a static `it.skip` reported through
// reportSkippedTest can have its TEST/POST (TestRunFinished) still pending when the worker tears
// down — the test then stays "in progress" on the dashboard. The awaited after() hook drains this
// so the chain completes while the session is still open. (Hook-skip cascades go via
// reportSuiteSkipped inside afterHook, which is already awaited, so they were unaffected.)
export function drainSkipReports(): Promise<void> {
    return reportChain
}

export function reportSkippedTest(framework: TestFramework, identifier: string, test: Frameworks.Test, suiteTitle?: string): Promise<void> {
    if (startedTests.has(identifier) || reportedSkips.has(identifier)) {
        return reportChain
    }
    reportedSkips.add(identifier)
    const result = { passed: false, skipped: true } as Frameworks.TestResult
    reportChain = reportChain.then(async () => {
        // LOG_REPORT/POST is what loads the result into the instance (loadTestResult is
        // gated on it, not on TEST/POST) — same sequence afterTest uses
        await framework.trackEvent(TestFrameworkState.INIT_TEST, HookState.PRE, { test })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { test, suiteTitle })
        await framework.trackEvent(TestFrameworkState.LOG_REPORT, HookState.POST, { test, result })
        await framework.trackEvent(TestFrameworkState.TEST, HookState.POST, { test, result, suiteTitle })
    }).catch((err: unknown) => {
        BStackLogger.debug(`Failed reporting skipped test '${identifier}': ${err}`)
    })
    return reportChain
}

/**
 * Port of the legacy insights-handler skip propagation: when a BEFORE_ALL/BEFORE_EACH/
 * AFTER_EACH hook fails (or skips), mocha silently drops the remaining tests in the
 * suite — report each state-undefined test as skipped, recursing into nested describes.
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
        await reportSkippedTest(framework, identifier, synthetic, parentTitle)
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
