import util from 'node:util'

import { BStackLogger } from '../../bstackLogger.js'
import PerformanceTester from './performance-tester.js'

/**
 * Per-command driver instrumentation.
 *
 * The lifecycle spans (driver init, pre/post initialize, quit) only cover what the SDK does
 * around a session. Everything the SDK does *per WebDriver command* — the a11y auto-scan, the
 * observability HTTP log, the Percy capture bookkeeping, the self-heal logData round trip — ran
 * unmeasured, which is why a benchmarked run shows a large in-session delta that no span accounts
 * for. `DRIVER_EVENT.PRE_EXECUTE` / `POST_EXECUTE` / `GET` exist for exactly this and were never
 * wired up here (the node agent wires the same constants in its `patchHelper`/`helper` driver
 * patches; wdio has no driver object to patch, so the equivalent hook points are the
 * `command`/`result` browser events and the `overwriteCommand` wrappers).
 *
 * Volume guard: `PerformanceTester` buffers every measure in memory (`_measuredEvents`) and
 * flushes once in `stopAndGenerate()`, so a span per command costs no extra disk I/O. It is not
 * free though — each measure is retained until the worker ends and every retained record is
 * serialised into the single EDS upload payload. A long run issuing tens of thousands of commands
 * would therefore inflate that payload without adding information, so per-label emission is capped
 * and the overflow is counted rather than recorded. Commands past the cap still execute exactly as
 * before; only their span is dropped.
 */

/**
 * Maximum number of spans emitted per label, per worker. A benchmark spec issues a few hundred
 * commands, so the cap is only reached by long soak runs — where the first N samples already
 * characterise the per-command cost.
 */
export const MAX_COMMAND_SPANS_PER_LABEL = 5000

const emittedSpans: Record<string, number> = {}
const droppedSpans: Record<string, number> = {}

/**
 * Navigation commands get their own span (`DRIVER_EVENT.GET`) because a navigation triggers the
 * most expensive per-command SDK work (a full page re-scan) and would otherwise be averaged away
 * inside the generic pre-execute bucket.
 */
const NAVIGATION_COMMANDS = new Set(['url', 'navigateto', 'navigate', 'get'])

export function isNavigationCommand(commandName?: string): boolean {
    try {
        return Boolean(commandName) && NAVIGATION_COMMANDS.has(String(commandName).toLowerCase())
    } catch {
        return false
    }
}

/**
 * Build a low-cardinality command label out of a WebDriver `command`/`result` event payload.
 * `endpoint` is the templated route (`/session/:sessionId/element`), not a live URL, so it is safe
 * to use as a detail value.
 */
export function commandLabelFromArgs(args?: { method?: string, endpoint?: string, command?: string }): string | undefined {
    try {
        if (!args) {
            return undefined
        }
        if (args.method && args.endpoint) {
            return `${args.method} ${args.endpoint}`
        }
        return args.endpoint || args.command || args.method
    } catch {
        return undefined
    }
}

function shouldEmitSpan(label: string): boolean {
    try {
        if (!PerformanceTester.started || !PerformanceTester.isEnabled()) {
            return false
        }
        const alreadyEmitted = emittedSpans[label] || 0
        if (alreadyEmitted >= MAX_COMMAND_SPANS_PER_LABEL) {
            droppedSpans[label] = (droppedSpans[label] || 0) + 1
            return false
        }
        emittedSpans[label] = alreadyEmitted + 1
        return true
    } catch {
        return false
    }
}

/**
 * Run a per-command phase of SDK work under a performance span.
 *
 * `fn` is invoked exactly once whether or not the span is emitted, and any error it throws
 * propagates unchanged — instrumentation never swallows nor introduces a failure in a customer's
 * run. If the tester itself misbehaves the phase falls back to calling `fn` directly.
 */
export function measureCommandPhase<T>(label: string, commandName: string | undefined, fn: () => T): T {
    let instrumented: (() => T) | undefined

    try {
        if (shouldEmitSpan(label)) {
            instrumented = PerformanceTester.measureWrapper(label, fn, { command: commandName }) as () => T
        }
    } catch (err) {
        BStackLogger.debug(`Could not instrument ${label} for command ${commandName}: ${util.format(err)}`)
        instrumented = undefined
    }

    return (instrumented || fn)()
}

/**
 * Log how many per-command spans were emitted and how many the cap dropped, so a report with
 * truncated per-command data is recognisable as truncated rather than as an idle run.
 */
export function logDriverCommandSpanSummary(): void {
    try {
        const labels = new Set([...Object.keys(emittedSpans), ...Object.keys(droppedSpans)])
        if (labels.size === 0) {
            return
        }
        const summary = [...labels]
            .map((label) => `${label} emitted=${emittedSpans[label] || 0} dropped=${droppedSpans[label] || 0}`)
            .join(', ')
        BStackLogger.debug(`[Performance] per-command driver spans: ${summary}`)
    } catch (err) {
        BStackLogger.debug(`Could not summarise per-command driver spans: ${util.format(err)}`)
    }
}

/**
 * Test hook — the counters are module state shared by every wrapper in the worker.
 */
export function resetDriverCommandSpanCounters(): void {
    for (const label of Object.keys(emittedSpans)) {
        delete emittedSpans[label]
    }
    for (const label of Object.keys(droppedSpans)) {
        delete droppedSpans[label]
    }
}
