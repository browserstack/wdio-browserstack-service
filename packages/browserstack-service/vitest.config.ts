import { defineConfig } from 'vitest/config'

/**
 * Standalone Vitest config for @wdio/browserstack-service (v8 line).
 *
 * In the monorepo, tests were driven by the repo-root vitest config + root `__mocks__/`.
 * Standalone, the manual mocks this suite resolves by convention live in `./__mocks__`
 * (copied/adapted from the monorepo root): @wdio/logger, @wdio/reporter (stats imported
 * from the published package), browserstack-local, fs, got, chalk. v8 uses `got` (not a
 * global `fetch`), so there is no fetch setup file.
 */
export default defineConfig({
    test: {
        dangerouslyIgnoreUnhandledErrors: true,
        include: ['tests/**/*.test.ts'],
        exclude: ['dist', 'build', '.idea', '.git', '.cache', '**/node_modules/**'],
        env: { WDIO_SKIP_DRIVER_SETUP: '1' },
        pool: 'forks',
        // Global per-file teardown (see vitest.setup.ts): restores real timers and
        // disconnects the PerformanceTester observer. Tests call startMonitoring()
        // without always calling stopAndGenerate(), leaving an open PerformanceObserver
        // handle that otherwise hangs the whole-suite run under Vitest 1.x teardown
        // (per-file is unaffected; upstream only ever runs these inside the full
        // monorepo suite, never standalone, so it never hit this).
        setupFiles: ['./__mocks__/vitest.setup.ts'],
        testTimeout: 30000
    }
})
