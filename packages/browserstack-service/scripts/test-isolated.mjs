/**
 * Run each test file in its own `vitest run` invocation, with a per-file timeout.
 *
 * Why: the whole-suite `vitest --run` hangs in teardown under Vitest 1.x, and some
 * individual files also fail to *exit* after their tests pass — the service leaves
 * open handles (e.g. a PerformanceObserver, or a `process.on('beforeExit')` handler in
 * the launcher) that keep the event loop alive once tests complete. Upstream
 * WebdriverIO never hits this because it only runs these specs inside the full
 * monorepo suite, never standalone.
 *
 * So we run one file per process and judge a file by whether its TESTS passed, not by
 * whether the process exited cleanly: tests complete in seconds, so if a process is
 * still alive at PER_FILE_TIMEOUT_MS it's a post-test teardown hang — we kill it and,
 * as long as the captured output shows a clean "Tests N passed" with no failures,
 * count it as a pass. Real test failures (or a missing summary) fail the run.
 *
 * `npm run test:watch` (plain `vitest`) remains available for local development.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PER_FILE_TIMEOUT_MS = 60000

function findTestFiles(dir) {
    const found = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
            found.push(...findTestFiles(full))
        } else if (full.endsWith('.test.ts')) {
            found.push(full)
        }
    }
    return found
}

/** Decide a file's result from vitest's captured output (independent of exit cleanliness). */
function classify(output) {
    if (/\bFAIL\b/.test(output) || /Tests\s+\d+ failed/.test(output) || /\d+ failed \|/.test(output)) {
        return 'failed'
    }
    if (/Tests\s+\d+ passed/.test(output) || /Tests\s+no tests/.test(output)) {
        return 'passed'
    }
    return 'no-summary'
}

const files = findTestFiles('tests').sort()
if (files.length === 0) {
    console.error('No test files found under tests/')
    process.exit(1)
}

console.log(`Running ${files.length} test files individually (per-file timeout ${PER_FILE_TIMEOUT_MS / 1000}s)\n`)

const failed = []
const hungButPassed = []
for (const file of files) {
    const res = spawnSync('vitest', ['run', file], {
        encoding: 'utf8',
        timeout: PER_FILE_TIMEOUT_MS,
        killSignal: 'SIGKILL'
    })
    const output = `${res.stdout || ''}${res.stderr || ''}`
    const verdict = classify(output)
    const timedOut = res.signal === 'SIGKILL' || res.error?.code === 'ETIMEDOUT'

    if (verdict === 'passed') {
        console.log(`✓ ${file}${timedOut ? '  (tests passed; killed lingering process — teardown hang)' : ''}`)
        if (timedOut) {
            hungButPassed.push(file)
        }
    } else {
        console.error(`✗ ${file}  [${verdict === 'no-summary' ? (timedOut ? 'hung before summary' : 'no test summary') : 'test failure'}]`)
        // surface the tail so CI logs show why
        console.error(output.split('\n').slice(-25).join('\n'))
        failed.push(file)
    }
}

console.log(`\n──────────────────────────────────────────`)
console.log(`${files.length - failed.length}/${files.length} test files passed` +
    (hungButPassed.length ? `  (${hungButPassed.length} had a post-test teardown hang, killed)` : ''))
if (failed.length > 0) {
    console.error(`\n${failed.length} file(s) FAILED:`)
    for (const f of failed) {
        console.error(`  ✗ ${f}`)
    }
    process.exit(1)
}
console.log('All test files passed ✓')
