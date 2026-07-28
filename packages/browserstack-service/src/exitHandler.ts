import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import BrowserStackConfig from './config.js'
import { saveFunnelData } from './instrumentation/funnelInstrumentation.js'
import { fileURLToPath } from 'node:url'
import { BROWSERSTACK_TESTHUB_JWT, BROWSERSTACK_TESTHUB_UUID } from './constants.js'
import PerformanceTester from './instrumentation/performance/performance-tester.js'
import TestOpsConfig from './testOps/testOpsConfig.js'
import { BStackLogger } from './bstackLogger.js'
import { BrowserstackCLI } from './cli/index.js'
import APIUtils from './cli/apiUtils.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// SDK-7061: a termination signal (SIGTERM / SIGINT / …) delivered mid-run kills the WDIO
// launcher before onComplete or the 'exit' hook can send the TRA build-stop, so the build
// hangs 'running' until the ~60-min server-side inactivity timeout. An async stop from a
// signal handler does NOT help: WDIO's launcher calls process.exit ~70ms into onComplete,
// the event loop stops, and the in-flight async PUT never lands. Java avoids this because
// Runtime.getRuntime().addShutdownHook runs synchronously and the JVM blocks exit until the
// hook returns. Node has no native sync HTTP, so replicate that blocking semantics with a
// spawnSync child: the parent process cannot exit until the stop PUT has completed.
// Guarded so we never double-send with onComplete or the 'exit' cleanup path.
const STOP_ENDPOINT_ENV = '__BROWSERSTACK_STOP_ENDPOINT'

// Inline script run by the blocking spawnSync child. Node `-e` defaults to CommonJS, so
// require() is available. Reads UUID/JWT/endpoint from the inherited env, PUTs the build
// stop, treats non-2xx as failure, retries up to 3x with backoff, exits 0 only on success.
const SYNC_STOP_SCRIPT = `
const uuid = process.env['${BROWSERSTACK_TESTHUB_UUID}'];
const jwt = process.env['${BROWSERSTACK_TESTHUB_JWT}'];
const endpoint = process.env['${STOP_ENDPOINT_ENV}'];
if (!uuid || !jwt || !endpoint) { process.exit(0); }
const target = endpoint + '/api/v1/builds/' + uuid + '/stop';
const body = JSON.stringify({ stop_time: new Date().toISOString() });
const lib = target.indexOf('https') === 0 ? require('https') : require('http');
function attempt(n) {
  const req = lib.request(target, {
    method: 'PUT',
    timeout: 4000,
    headers: {
      'Content-Type': 'application/json',
      'X-BSTACK-OBS': 'true',
      'Authorization': 'Bearer ' + jwt,
      'Content-Length': Buffer.byteLength(body)
    }
  }, function (res) {
    let d = '';
    res.on('data', function (c) { d += c; });
    res.on('end', function () {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        process.stdout.write('[STOP_BUILD] sync stop success ' + res.statusCode + '\\n');
        process.exit(0);
      } else {
        retry(n, 'HTTP ' + res.statusCode);
      }
    });
  });
  req.on('error', function (e) { retry(n, e && e.message); });
  req.on('timeout', function () { req.destroy(new Error('timeout')); });
  req.write(body);
  req.end();
}
function retry(n, msg) {
  process.stdout.write('[STOP_BUILD] sync attempt ' + n + ' failed: ' + msg + '\\n');
  if (n < 3) { setTimeout(function () { attempt(n + 1); }, 500 * n); }
  else { process.exit(1); }
}
attempt(1);
`

let signalHandlersRegistered = false
let buildStopSentOnSignal = false

// SDK-7061: synchronous, blocking build-stop mirroring java's addShutdownHook. The parent
// BLOCKS on spawnSync until the child's stop PUT completes, guaranteeing it lands before
// process.exit. Only the direct-HTTP (non-CLI) observability path with a created build is
// handled here — the CLI manages its own build lifecycle. Best-effort, never throws.
function stopBuildSyncBlocking(reason: string): void {
    const config = BrowserStackConfig.getInstance()
    if (buildStopSentOnSignal || config.testObservability.buildStopped) {
        return
    }
    if (!process.env[BROWSERSTACK_TESTHUB_UUID] || !process.env[BROWSERSTACK_TESTHUB_JWT]) {
        return
    }
    if (BrowserstackCLI.getInstance().isRunning()) {
        return
    }
    buildStopSentOnSignal = true
    try {
        BStackLogger.debug(`Shutdown (${reason}) — stopping TestHub build synchronously (blocking)`)
        const result = spawnSync(process.execPath, ['-e', SYNC_STOP_SCRIPT], {
            timeout: 15000,
            encoding: 'utf-8',
            env: { ...process.env, [STOP_ENDPOINT_ENV]: APIUtils.DATA_ENDPOINT }
        })
        if (result.stdout) {
            BStackLogger.debug(`[STOP_BUILD] sync child stdout: ${String(result.stdout).trim()}`)
        }
        if (result.stderr) {
            BStackLogger.debug(`[STOP_BUILD] sync child stderr: ${String(result.stderr).trim()}`)
        }
        if (result.status === 0) {
            config.testObservability.buildStopped = true
            BStackLogger.debug('[STOP_BUILD] sync stop completed successfully')
        } else {
            BStackLogger.debug(`[STOP_BUILD] sync stop did not confirm success (status=${result.status}, signal=${result.signal})`)
        }
    } catch (err) {
        BStackLogger.debug(`Error stopping build synchronously on ${reason}: ${err}`)
    }
}

function registerSignalHandlers(): void {
    if (signalHandlersRegistered) {
        return
    }
    signalHandlersRegistered = true

    const onSignal = (signal: NodeJS.Signals) => {
        stopBuildSyncBlocking(signal)
        process.exit(0)
    }

    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
    process.on('SIGHUP', onSignal)
    if (process.platform === 'win32') {
        process.on('SIGBREAK', onSignal)
    } else {
        process.on('SIGABRT', onSignal)
        process.on('SIGQUIT', onSignal)
    }

    process.on('uncaughtException', (err) => {
        BStackLogger.debug(`Uncaught exception — stopping TestHub build: ${err?.stack || err}`)
        stopBuildSyncBlocking('uncaughtException')
        process.exit(1)
    })
}

export function setupExitHandlers() {
    registerSignalHandlers()
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
        // 'exit' can only do sync work; the blocking spawnSync stop fits. This is the
        // guaranteed catch-all — even when WDIO's own process.exit pre-empts our signal
        // handler, this still runs synchronously before the process dies (SDK-7061).
        stopBuildSyncBlocking('exit')
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
