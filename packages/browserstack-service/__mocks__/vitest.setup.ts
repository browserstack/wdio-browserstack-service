import { afterAll, vi } from 'vitest'

/**
 * Global per-file teardown for the standalone test run.
 *
 * Restores real timers (several specs install fake timers at module scope and never
 * restore them) and disconnects the PerformanceTester observer (specs call
 * startMonitoring() without always calling stopAndGenerate()). Both are no-ops for
 * files that didn't trigger them. The performance-tester is pulled in via a *dynamic*
 * import so this setup file doesn't perturb the service's module init order (a static
 * import triggers a circular `@PerformanceTester.measureWrapper` decorator failure).
 *
 * NOTE: this is necessary but NOT sufficient — the whole-suite `vitest --run` still
 * hangs in teardown under Vitest 1.x even though every file passes and exits cleanly in
 * isolation. Tracked as the standalone teardown follow-up.
 */
afterAll(async () => {
    vi.useRealTimers()
    try {
        const mod = await import('../src/instrumentation/performance/performance-tester.js')
        mod.default?._observer?.disconnect()
    } catch {
        /* monitoring was never started in this file */
    }
})
