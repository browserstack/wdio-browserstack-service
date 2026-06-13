import { defineConfig } from 'vitest/config'

/**
 * Standalone Vitest config for @wdio/browserstack-service.
 *
 * In the WebdriverIO monorepo this package was tested by the root vitest.config.ts
 * which resolved manual mocks from the repo-root `__mocks__/` directory. Standalone,
 * the mocks this package relies on live in `./__mocks__` (copied/adapted from the
 * monorepo root): @wdio/logger, @wdio/reporter, browserstack-local, fs, chalk, plus
 * the `fetch` setup file.
 */
export default defineConfig({
    test: {
        dangerouslyIgnoreUnhandledErrors: true,
        include: ['tests/**/*.test.ts'],
        exclude: ['dist', 'build', '.idea', '.git', '.cache', '**/node_modules/**'],
        env: {
            WDIO_SKIP_DRIVER_SETUP: '1'
        },
        // address intermittent Vitest worker errors (see vitest-dev/vitest#6511)
        pool: 'threads',
        coverage: {
            enabled: false,
            provider: 'v8',
            exclude: [
                '**/__mocks__/**',
                '**/build/**',
                '**/*.test.ts',
                '**/*.test-d.ts'
            ]
        },
        setupFiles: ['./__mocks__/fetch.ts', './__mocks__/vitest.setup.ts'],
        testTimeout: 30000
    }
})
