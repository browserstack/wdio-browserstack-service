import { afterAll, vi } from 'vitest'

/**
 * Several specs install fake timers at module scope (e.g. reporter.test.ts:
 * `vi.useFakeTimers()`) and never restore them. Leftover fake timers replace
 * the global setTimeout/setImmediate, which prevents a Vitest worker from
 * exiting cleanly after its LAST file — hanging the whole run in teardown with
 * no summary printed. Restoring real timers at the end of every file guarantees
 * each worker can shut down regardless of which file ran last. This is a no-op
 * for files that already use real timers.
 */
afterAll(() => {
    vi.useRealTimers()
})
