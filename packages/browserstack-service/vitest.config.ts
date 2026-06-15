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
        // 'threads' (matching the v9 line) lets Vitest force-terminate workers on
        // teardown; with 'forks', a child process left holding an open handle (e.g. a
        // got keep-alive socket / gRPC channel in an error-path test) hangs the whole
        // run after the last file even though every test has already passed.
        pool: 'threads',
        // Restore real timers after every file — 9 specs install fake timers at
        // module scope and never restore them, which compounds the teardown hang.
        setupFiles: ['./__mocks__/vitest.setup.ts'],
        testTimeout: 30000
    }
})
