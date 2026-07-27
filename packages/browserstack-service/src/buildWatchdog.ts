import fs from 'node:fs'
import path from 'node:path'

// SDK-7061: standalone, detached watchdog. Spawned by the launcher with detached:true so
// it lives in its own session and survives a kill -9 of the launcher's process group.
// It watches the launcher; if the launcher dies without a clean shutdown (marker still
// present) it sends the TRA build-stop PUT itself, so the build reaches a terminal state
// instead of hanging 'running' until the server-side inactivity timeout.
//
// It is bundled independently (no shared imports with the SDK), so the request logic and
// logging are inlined deliberately.

interface Marker {
    buildUuid: string
    dataEndpoint: string
    launcherPid: number
}

const POLL_INTERVAL_MS = 2000
const DEFAULT_MAX_LIFETIME_MS = 45 * 60 * 1000
const MAX_LIFETIME_MS = Number(process.env.BROWSERSTACK_BUILD_WATCHDOG_TIMEOUT_MS) || DEFAULT_MAX_LIFETIME_MS

const markerPath = process.argv[2]
const logPath = markerPath ? path.join(path.dirname(markerPath), 'bstack_build_watchdog.log') : undefined

function log(msg: string): void {
    if (!logPath) {
        return
    }
    try {
        fs.appendFileSync(logPath, `[WATCHDOG] ${new Date().toISOString()} ${msg}\n`)
    } catch {
        // best-effort; the watchdog must never throw
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (err) {
        // ESRCH = no such process (dead); EPERM = exists but not ours (alive)
        return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
}

function readMarker(): Marker | undefined {
    try {
        return JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Marker
    } catch {
        return undefined
    }
}

async function sendStop(marker: Marker): Promise<boolean> {
    // SECURITY (SDK-7061): the JWT is read from the inherited environment, never from disk.
    const jwt = process.env.BROWSERSTACK_TESTHUB_JWT
    if (!jwt) {
        log('[STOP_BUILD] no JWT in environment — cannot stop build')
        return false
    }
    const url = `${marker.dataEndpoint}/api/v1/builds/${marker.buildUuid}/stop`
    const body = JSON.stringify({ stop_time: new Date().toISOString() })
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-BSTACK-OBS': 'true',
                    'Authorization': `Bearer ${jwt}`
                },
                body
            })
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`)
            }
            log(`[STOP_BUILD] watchdog stopped build ${marker.buildUuid} (attempt ${attempt})`)
            return true
        } catch (err) {
            log(`[STOP_BUILD] attempt ${attempt}/${maxAttempts} failed: ${err}`)
            if (attempt < maxAttempts) {
                await sleep(500 * attempt)
            }
        }
    }
    log(`[STOP_BUILD] watchdog failed to stop build ${marker.buildUuid} after ${maxAttempts} attempts`)
    return false
}

async function run(): Promise<void> {
    if (!markerPath) {
        return
    }
    const marker = readMarker()
    if (!marker) {
        log('no marker at startup — exiting')
        return
    }
    log(`watching launcher pid=${marker.launcherPid} for build ${marker.buildUuid}`)

    const deadline = Date.now() + MAX_LIFETIME_MS
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS)

        // Clean shutdown: the launcher (or its exit-cleanup) deletes the marker once it
        // has stopped the build itself. Nothing to do.
        if (!fs.existsSync(markerPath)) {
            log('marker deleted — clean shutdown, exiting')
            return
        }

        if (!isProcessAlive(marker.launcherPid)) {
            log(`launcher pid=${marker.launcherPid} is dead and marker still present — stopping build`)
            await sendStop(marker)
            try {
                fs.rmSync(markerPath, { force: true })
            } catch {
                // best-effort
            }
            return
        }
    }
    // Launcher stayed alive past the safety bound — its own onComplete owns the stop.
    log('max lifetime reached with launcher alive — exiting without stopping')
}

run().catch((err) => log(`unexpected error: ${err}`))
