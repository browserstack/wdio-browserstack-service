import type { Options } from '@wdio/types'

import { BStackLogger } from './bstackLogger.js'

/**
 * WDIO config hooks that execute in the worker process WITH a live session, so a driver
 * command issued inside them is meaningful.
 *
 * Deliberately excluded:
 *  - `onPrepare` / `onWorkerStart` / `onWorkerEnd` / `onComplete` — launcher process, no driver.
 *  - `beforeSession` — runs before the session is created; there is no browser yet.
 *  - `afterSession` — the session is already being deleted; commands there fail.
 *  - `beforeCommand` / `afterCommand` — a live driver, but per-command: their window is the
 *    command, which is already observable, and wrapping them would log on every interaction.
 */
export const BROWSER_CONTEXT_HOOKS = [
    'before',
    'beforeSuite',
    'beforeHook',
    'beforeTest',
    'afterTest',
    'afterHook',
    'afterSuite',
    'after'
] as const

type HookFn = (...args: unknown[]) => unknown

const INSTRUMENTED = Symbol('bstackHookInstrumented')

/**
 * Failure message per hook name, for the hooks WDIO reports to nobody.
 *
 * `executeHooksWithArgs` resolves with the error instead of rejecting — deliberately, so a
 * throwing config hook cannot fail the run — which means a failed `before()` leaves the exit code
 * at 0, the reporters green and the dashboard reading "passed". Anything that reports on that
 * window needs a way to know it actually blew up, and this wrapper is the only thing that sees it.
 */
const hookFailures: Record<string, string> = {}

export const getHookFailure = (hookName: string): string | undefined => hookFailures[hookName]

/**
 * The config hooks that can run inside the pre-test window — driver alive, no test started yet.
 *
 * `beforeSuite` belongs here and is easy to miss: the Mocha adapter registers it as a root
 * before-all (`this._runner.suite.beforeAll(this.wrapHook('beforeSuite'))`), so it runs after the
 * config-level `before` and still ahead of the first test. Hardcoding `'before'` reported a window
 * as passed when it was `beforeSuite` that threw.
 *
 * Mocha's own hooks are excluded deliberately: each already has its own hook run with its own
 * result, so folding their failures in here would report the same failure twice.
 */
export const PRE_TEST_WINDOW_HOOKS = ['before', 'beforeSuite'] as const

/**
 * First failure recorded by any handler that ran in the pre-test window.
 *
 * Any handler in those arrays counts, including another service's — from the window's point of
 * view the setup did fail, whoever owned the throw. The message identifies which.
 */
export const getPreTestWindowFailure = (): string | undefined => {
    for (const hookName of PRE_TEST_WINDOW_HOOKS) {
        if (hookFailures[hookName]) {
            return `${hookName}: ${hookFailures[hookName]}`
        }
    }
    return undefined
}

/**
 * Wrap one handler so its entry and exit are observable, preserving its shape exactly.
 *
 * Sync handlers stay sync: an `async` wrapper would turn every sync hook into a promise and a
 * synchronous throw into a rejection, which changes ordering for anything that calls a hook
 * without awaiting it. So the wrapper only attaches to the promise when the handler actually
 * returned one.
 */
const instrument = (hookName: string, index: number, fn: HookFn): HookFn => {
    if ((fn as unknown as Record<symbol, unknown>)[INSTRUMENTED]) {
        return fn
    }

    // `fn.name` is the only identity WDIO leaves: ConfigParser binds every handler it folds in
    // (`hook.bind(service)`), so both the user's config hooks and other services' hooks read as
    // `bound <name>`. Logged anyway — it separates a named user function from an anonymous one.
    const label = `${hookName}#${index}${fn.name ? ` (${fn.name})` : ''}`
    const recordFailure = (error: unknown) => {
        hookFailures[hookName] = (error as Error)?.message || String(error)
    }
    const wrapped = function (this: unknown, ...args: unknown[]) {
        const startedAt = Date.now()
        const finish = (outcome: string) => BStackLogger.debug(`[hook-window] ${label} ${outcome} in ${Date.now() - startedAt}ms`)

        BStackLogger.debug(`[hook-window] ${label} started`)
        let result: unknown
        try {
            result = fn.apply(this, args)
        } catch (error) {
            recordFailure(error)
            finish(`threw: ${(error as Error)?.message}`)
            throw error
        }

        if (result && typeof (result as Promise<unknown>).then === 'function') {
            return (result as Promise<unknown>).then(
                (value) => {
                    finish('finished')
                    return value
                },
                (error) => {
                    recordFailure(error)
                    finish(`rejected: ${(error as Error)?.message}`)
                    throw error
                }
            )
        }

        finish('finished')
        return result
    } as HookFn

    Object.defineProperty(wrapped, INSTRUMENTED, { value: true })
    return wrapped
}

/**
 * Make the boundaries of every session-scoped config hook observable.
 *
 * WDIO tells a service nothing about the other handlers registered for a hook: `ConfigParser`
 * folds the user's config hooks and every service's hooks into one array per hook name, and the
 * runner fires them together (`executeHooksWithArgs` → `Promise.all`). Patching the array in
 * place is therefore the only way to see when a handler that is not ours starts and finishes —
 * which is what bounds the windows a driver command can fall into.
 *
 * The index in the label is the handler's position in that merged array, so it includes this
 * service's own handlers; it identifies a handler across its start/finish pair, nothing more.
 *
 * Logging only, for now: no events are emitted and no behaviour changes. Idempotent, and any
 * failure is swallowed — instrumentation must never be the reason a suite cannot start.
 */
export function instrumentBrowserContextHooks(config?: Options.Testrunner): void {
    if (!config) {
        return
    }

    try {
        const record = config as unknown as Record<string, unknown>
        // Instrumenting a config starts a fresh record. Without this the map is process-global
        // for the worker's lifetime, so a failure from one instrumented config could be reported
        // against a later one.
        for (const hookName of BROWSER_CONTEXT_HOOKS) {
            delete hookFailures[hookName]
        }
        for (const hookName of BROWSER_CONTEXT_HOOKS) {
            const handlers = record[hookName]
            if (!Array.isArray(handlers) || handlers.length === 0) {
                continue
            }
            BStackLogger.debug(`[hook-window] instrumenting ${hookName}: ${handlers.length} handler(s) registered at service construction`)
            record[hookName] = handlers.map((handler, index) =>
                typeof handler === 'function' ? instrument(hookName, index, handler as HookFn) : handler
            )
        }
    } catch (error) {
        BStackLogger.debug(`Could not instrument config hooks: ${error}`)
    }
}
