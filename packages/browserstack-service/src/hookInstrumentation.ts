import type { Options } from '@wdio/types'

import { BStackLogger } from './bstackLogger.js'
import { BROWSER_CONTEXT_HOOKS, HOOK_WINDOW_LOG_PREFIX, PRE_TEST_WINDOW_HOOKS } from './constants.js'

type HookFn = (...args: unknown[]) => unknown

const INSTRUMENTED = Symbol('bstackHookInstrumented')

/**
 * Run our own bookkeeping so it can never affect the hook it wraps.
 *
 * This code executes inside the user's hook. A throw from anything here — a logger whose stream
 * has gone, a Proxy that dislikes String() — would surface as their hook failing, in a hook WDIO
 * reports to nobody. The handler's own error is never routed through this.
 */
const quietly = (fn: () => void): void => {
    try {
        fn()
    } catch {
        // instrumentation is not worth a failed hook
    }
}

/** `.then` may be a throwing getter on a hostile object, and we only need to know if it is callable. */
const isThenable = (value: unknown): boolean => {
    try {
        return Boolean(value) && typeof (value as Promise<unknown>).then === 'function'
    } catch {
        return false
    }
}

const hookFailures: Record<string, string> = {}
/** Innermost last: WDIO fires same-named handlers concurrently and nests hook kinds. */
const activeHooks: string[] = []

export const getActiveHookName = (): string | undefined => activeHooks[activeHooks.length - 1]

/**
 * First failure from a hook that ran before the first test, prefixed with its hook name.
 *
 * `executeHooksWithArgs` resolves WITH a hook's error rather than rejecting, so a throwing config
 * hook leaves the exit code at 0 and every reporter green. This wrapper is the only thing that
 * sees it. Any handler counts, including another service's — the window failed either way.
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
 * Sync handlers stay sync — an `async` wrapper would turn a synchronous throw into a rejection and
 * defer every hook body by a microtask, which is observable to anything not awaiting the hook.
 */
const instrument = (hookName: string, index: number, fn: HookFn): HookFn => {
    if ((fn as unknown as Record<symbol, unknown>)[INSTRUMENTED]) {
        return fn
    }

    // ConfigParser binds every handler it folds in, so `fn.name` reads as `bound <name>` for the
    // user's hooks and other services' alike; the index is what identifies one across its pair.
    const label = `${hookName}#${index}${fn.name ? ` (${fn.name})` : ''}`
    const recordFailure = (error: unknown) => {
        hookFailures[hookName] = (error as Error)?.message || String(error)
    }
    const leave = () => {
        const at = activeHooks.lastIndexOf(hookName)
        if (at !== -1) {
            activeHooks.splice(at, 1)
        }
    }

    const wrapped = function (this: unknown, ...args: unknown[]) {
        const startedAt = Date.now()
        const finish = (outcome: string) => quietly(() =>
            BStackLogger.debug(`${HOOK_WINDOW_LOG_PREFIX} ${label} ${outcome} in ${Date.now() - startedAt}ms`))

        quietly(() => {
            BStackLogger.debug(`${HOOK_WINDOW_LOG_PREFIX} ${label} started`)
            activeHooks.push(hookName)
        })

        let result: unknown
        try {
            result = fn.apply(this, args)
        } catch (error) {
            quietly(() => {
                recordFailure(error)
                leave()
            })
            finish(`threw: ${(error as Error)?.message}`)
            throw error
        }

        if (isThenable(result)) {
            return (result as Promise<unknown>).then(
                (value) => {
                    quietly(leave)
                    finish('finished')
                    return value
                },
                (error) => {
                    quietly(() => {
                        recordFailure(error)
                        leave()
                    })
                    finish(`rejected: ${(error as Error)?.message}`)
                    throw error
                }
            )
        }

        quietly(leave)
        finish('finished')
        return result
    } as HookFn

    Object.defineProperty(wrapped, INSTRUMENTED, { value: true })
    return wrapped
}

/**
 * Make the boundaries of every session-scoped config hook observable.
 *
 * WDIO tells a service nothing about the other handlers on a hook — ConfigParser folds the user's
 * and every service's into one array per hook name, fired together via `Promise.all` — so patching
 * the array in place is the only way to see a handler that is not ours start and finish.
 *
 * Logging only. Idempotent, and never throws: instrumentation must not stop a suite starting.
 */
export function instrumentBrowserContextHooks(config?: Options.Testrunner): void {
    if (!config) {
        return
    }

    try {
        const record = config as unknown as Record<string, unknown>
        activeHooks.length = 0
        for (const hookName of BROWSER_CONTEXT_HOOKS) {
            // fresh record per config: the maps live as long as the worker
            delete hookFailures[hookName]

            const handlers = record[hookName]
            if (!Array.isArray(handlers) || handlers.length === 0) {
                continue
            }
            quietly(() => BStackLogger.debug(`${HOOK_WINDOW_LOG_PREFIX} instrumenting ${hookName}: ${handlers.length} handler(s)`))
            record[hookName] = handlers.map((handler, index) => {
                if (typeof handler !== 'function') {
                    return handler
                }
                try {
                    return instrument(hookName, index, handler as HookFn)
                } catch {
                    // hand back the original rather than losing the hook, or the ones after it
                    return handler
                }
            })
        }
    } catch (error) {
        // including this one: a throwing logger here would escape the function entirely
        quietly(() => BStackLogger.debug(`Could not instrument config hooks: ${error}`))
    }
}
