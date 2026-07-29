import { spawn } from 'node:child_process'
import path from 'node:path'
import exitHook from 'async-exit-hook'
import BrowserStackConfig from './config.js'
import { saveFunnelData } from './instrumentation/funnelInstrumentation.js'
import { fileURLToPath } from 'node:url'
import { BROWSERSTACK_TESTHUB_JWT, BROWSERSTACK_TESTHUB_UUID } from './constants.js'
import PerformanceTester from './instrumentation/performance/performance-tester.js'
import TestOpsConfig from './testOps/testOpsConfig.js'
import { BStackLogger } from './bstackLogger.js'
import { BrowserstackCLI } from './cli/index.js'
import { stopBuildUpstream } from './util.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// SDK-7061: a termination signal (SIGTERM / SIGINT / SIGHUP) delivered mid-run kills the WDIO
// launcher before onComplete can send the TRA build-stop, so the build hangs 'running' until
// the ~60-min server-side inactivity timeout. We register the stop through async-exit-hook —
// the SAME package @wdio/cli's launcher hooks (a single hoisted copy) — so our async stop is
// awaited in the same ordered exit as WDIO's own runner.shutdown(), and async-exit-hook itself
// owns the process.exit with the conventional signal code (SIGTERM=143 / SIGINT=130). We never
// call process.exit, so the exit code is preserved and WDIO's async cleanup is not aborted. The
// stop goes through the proxy-aware stopBuildUpstream() (fetchWrapper → undici ProxyAgent),
// which already retries 3x with backoff (~1.5s worst case, well within the hook's ~10s budget).
let asyncStopHookRegistered = false
let buildStopInFlight = false

// Best-effort build-stop invoked from the async exit hook. Only the direct-HTTP (non-CLI)
// observability path with a created build (UUID + JWT present) and a not-yet-stopped build is
// handled; the CLI manages its own build lifecycle. Never throws.
export async function stopBuildOnShutdown(): Promise<void> {
    // setupExitHandlers() runs in the launcher constructor, potentially before
    // BrowserStackConfig is initialized; guard so a shutdown during that window is a no-op.
    const config = BrowserStackConfig.getInstance()
    if (!config) {
        return
    }
    if (buildStopInFlight || config.testObservability?.buildStopped) {
        return
    }
    if (!process.env[BROWSERSTACK_TESTHUB_UUID] || !process.env[BROWSERSTACK_TESTHUB_JWT]) {
        return
    }
    if (BrowserstackCLI.getInstance().isRunning()) {
        return
    }
    buildStopInFlight = true
    try {
        BStackLogger.debug('Shutdown signal — stopping TestHub build via async exit hook')
        const result = await stopBuildUpstream() as { status?: string } | undefined
        if (result?.status === 'success') {
            config.testObservability.buildStopped = true
            BStackLogger.debug('[STOP_BUILD] async shutdown stop completed successfully')
        } else {
            BStackLogger.debug(`[STOP_BUILD] async shutdown stop did not confirm success (status=${result?.status})`)
        }
    } catch (err) {
        BStackLogger.debug(`Error stopping build on shutdown: ${err}`)
    }
}

function registerAsyncStopHook(): void {
    if (asyncStopHookRegistered) {
        return
    }
    asyncStopHookRegistered = true
    // Declaring the `done` callback marks this hook async: async-exit-hook awaits `done()`
    // (up to its force-exit timeout) before letting the ordered exit proceed. stopBuildOnShutdown
    // never rejects, so `.finally(done)` always releases the hook.
    exitHook((done: () => void) => {
        stopBuildOnShutdown().finally(done)
    })
}

export function setupExitHandlers() {
    registerAsyncStopHook()
    const handleCLICleanup = () => {
        BStackLogger.debug('Handling CLI cleanup in exit handler')
        try {
            const cliProcess = BrowserstackCLI.getInstance()?.process

            if (cliProcess && cliProcess.pid && cliProcess.exitCode === null) {
                BStackLogger.debug(`Found CLI process with PID ${cliProcess.pid}, terminating`)
                try {
                    if (process.platform === 'win32') {
                        cliProcess.kill('SIGTERM')
                        BStackLogger.debug('CLI process terminated successfully with SIGTERM (Windows)')
                    } else {
                        cliProcess.kill('SIGINT')
                        BStackLogger.debug('CLI process terminated successfully with SIGINT (Unix)')
                    }
                } catch (processError) {
                    BStackLogger.debug(`CLI process termination error: ${processError}`)
                    try {
                        cliProcess.kill()
                        BStackLogger.debug('CLI process terminated with default signal (fallback)')
                    } catch (fallbackError) {
                        BStackLogger.debug(`CLI process fallback termination error: ${fallbackError}`)
                    }
                }
            } else {
                BStackLogger.debug('No CLI process found to terminate')
            }
        } catch (error) {
            BStackLogger.debug(`Error in CLI cleanup: ${error}`)
        }
    }
    process.on('exit', () => {
        const isCLIEnabled = BrowserstackCLI.getInstance().isRunning()
        handleCLICleanup()
        const args = shouldCallCleanup(BrowserStackConfig.getInstance(), isCLIEnabled)
        if (Array.isArray(args) && args.length) {
            BStackLogger.debug(`Spawning cleanup.js with args: ${args.join(', ')}`)
            const childProcess = spawn('node', [`${path.join(__dirname, 'cleanup.js')}`, ...args], { detached: true, stdio: 'inherit', env: { ...process.env } })
            childProcess.unref()
        }
    })
}

export function shouldCallCleanup(config: BrowserStackConfig, isCLIEnabled = false): string[] {
    const args: string[] = []
    if (!!process.env[BROWSERSTACK_TESTHUB_JWT] && !config.testObservability.buildStopped) {
        args.push('--observability')
    }

    if (config.userName && config.accessKey && !config.funnelDataSent) {
        const savedFilePath = saveFunnelData('SDKTestSuccessful', config, isCLIEnabled)
        args.push('--funnelData', savedFilePath)
    }

    if (PerformanceTester.isEnabled()) {
        process.env.PERF_USER_NAME = config.userName
        process.env.PERF_TESTHUB_UUID = TestOpsConfig.getInstance().buildHashedId
        process.env.SDK_RUN_ID = config.sdkRunID
        args.push('--performanceData')
    }

    return args
}
