import { spawn } from 'node:child_process'
import path from 'node:path'
import BrowserStackConfig from './config.js'
import { saveFunnelData } from './instrumentation/funnelInstrumentation.js'
import { fileURLToPath } from 'node:url'
import PerformanceTester from './instrumentation/performance/performance-tester.js'
import TestOpsConfig from './testOps/testOpsConfig.js'
import { BStackLogger } from './bstackLogger.js'
import { BrowserstackCLI } from './cli/index.js'
import { BROWSERSTACK_TESTHUB_JWT, BROWSERSTACK_TESTHUB_UUID, BROWSERSTACK_KILL_SIGNAL } from './constants.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SIGNAL_EXIT_CODES: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGTERM: 15, SIGBREAK: 21 }
const FORCED_EXIT_GRACE_MS = 5000

function getInterruptSignals(): NodeJS.Signals[] {
    const allSignals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP']
    if (process.platform !== 'win32') {
        allSignals.push('SIGABRT', 'SIGQUIT')
    } else {
        // For windows Ctrl+Break
        allSignals.push('SIGBREAK')
    }
    return allSignals
}

export function setupExitHandlers() {
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

    getInterruptSignals().forEach((sig) => {
        process.on(sig, () => {
            BStackLogger.debug(`${sig} received, setting kill signal`)
            BrowserStackConfig.getInstance().setKillSignal(sig)
            process.env[BROWSERSTACK_KILL_SIGNAL] = sig

            // Listening on a signal suppresses Node's default termination. Give the
            // runner's own shutdown a grace window, then force the conventional 128+n
            // exit — a hung shutdown would otherwise live until CI's SIGKILL, which
            // fires no 'exit' event and skips the cleanup rescue. unref() so a
            // naturally exiting process is never held open.
            const timer = setTimeout(() => {
                process.exit(128 + (SIGNAL_EXIT_CODES[sig] || 0))
            }, FORCED_EXIT_GRACE_MS)
            timer.unref()
        })
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

    // A signal-terminated run never reaches onComplete's log upload, leaving the
    // build with no SDK-log object — rescue it from the detached cleanup process.
    const clientBuildUuid = process.env[BROWSERSTACK_TESTHUB_UUID] || config.sdkRunID
    if (!config.logsUploaded && config.userName && config.accessKey && clientBuildUuid) {
        args.push('--uploadLogs', clientBuildUuid)
    }

    return args
}
