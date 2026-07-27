import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { BStackLogger } from './bstackLogger.js'
import { BROWSERSTACK_TESTHUB_UUID, BROWSERSTACK_TESTHUB_JWT } from './constants.js'
import APIUtils from './cli/apiUtils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const BUILD_WATCHDOG_MARKER_FILE = 'bstack_build_active.json'

// SDK-7061: a hard kill (kill -9 / OOM) of the WDIO launcher runs neither onComplete
// nor process.on('exit'), so the direct-HTTP TRA build never receives its stop PUT and
// hangs 'running' until the ~60-min server-side inactivity timeout. A detached watchdog
// process (own session, survives a kill of the launcher's process group) stops the build
// once it observes the launcher is dead and the run never signalled a clean shutdown.

export function getMarkerPath(): string {
    return path.join(BStackLogger.logFolderPath, BUILD_WATCHDOG_MARKER_FILE)
}

export function deleteBuildWatchdogMarker(): void {
    try {
        fs.rmSync(getMarkerPath(), { force: true })
    } catch (err) {
        BStackLogger.debug(`[WATCHDOG] Failed to delete marker: ${err}`)
    }
}

export function startBuildWatchdog(): void {
    try {
        const buildUuid = process.env[BROWSERSTACK_TESTHUB_UUID]
        const jwt = process.env[BROWSERSTACK_TESTHUB_JWT]
        if (!buildUuid || !jwt) {
            return
        }

        const markerPath = getMarkerPath()
        if (!fs.existsSync(BStackLogger.logFolderPath)) {
            fs.mkdirSync(BStackLogger.logFolderPath, { recursive: true, mode: 0o700 })
        }
        // SECURITY (SDK-7061): the JWT is a bearer credential and is NOT persisted to disk.
        // The detached watchdog inherits it via the environment (BROWSERSTACK_TESTHUB_JWT)
        // that this launcher process already carries. The marker holds only non-secret fields
        // and is written owner-only (0o600) as defense-in-depth.
        fs.writeFileSync(markerPath, JSON.stringify({
            buildUuid,
            dataEndpoint: APIUtils.DATA_ENDPOINT,
            launcherPid: process.pid,
            createdAt: new Date().toISOString()
        }), { mode: 0o600 })
        try {
            fs.chmodSync(markerPath, 0o600)
        } catch {
            // best-effort (e.g. Windows); marker carries no secret regardless
        }

        const watchdogPath = path.join(__dirname, 'buildWatchdog.js')
        // detached:true → own session/process-group (setsid); a kill -9 of the launcher's
        // process group does not reach it. unref() lets the launcher exit independently.
        // The child inherits this process's env (incl. the JWT) — no explicit env passed.
        const child = spawn(process.execPath, [watchdogPath, markerPath], {
            detached: true,
            stdio: 'ignore'
        })
        child.unref()
        BStackLogger.debug(`[WATCHDOG] Spawned detached build watchdog pid=${child.pid} for build ${buildUuid}`)
    } catch (err) {
        BStackLogger.debug(`[WATCHDOG] Failed to start build watchdog: ${err}`)
    }
}
