import path from 'node:path'
import fs from 'node:fs'

import type { TestData, UploadType } from '../types.js'
import { batchAndPostEvents } from '../util.js'
import { DATA_BATCH_ENDPOINT } from '../constants.js'
import { BStackLogger } from '../bstackLogger.js'

/**
 * Crash-resilient journal of test and hook runs that have sent TestRunStarted /
 * HookRunStarted but not yet the matching finish. Each open run is persisted as a small
 * file so that if the worker (or the whole wdio process tree) is killed mid-test or
 * mid-hook, the launcher's shutdown path or the detached exit cleanup can still send a
 * synthetic TestRunFinished / HookRunFinished — otherwise the entity stays "in progress"
 * on the Test Reporting & Analytics dashboard until the backend watchdog times it out,
 * inflating the reported build duration (SDK-7167: an orphaned AFTER_EACH cucumber hook
 * added its 2h hook timeout to the build's duration on the new dashboard).
 */

const OPEN_RUNS_DIR = path.join(process.cwd(), 'logs', 'bstack_open_runs')

export const ORPHAN_FAILURE_REASON = 'Test run did not complete: the process was interrupted or terminated before the test finished (finalized by BrowserStack SDK exit cleanup)'

function openRunFilePath(uuid: string) {
    return path.join(OPEN_RUNS_DIR, `open-run-${uuid}.json`)
}

export function recordOpenRun(testData: TestData) {
    if (!testData || !testData.uuid) {
        return
    }
    try {
        fs.mkdirSync(OPEN_RUNS_DIR, { recursive: true })
        fs.writeFileSync(openRunFilePath(testData.uuid), JSON.stringify(testData))
    } catch (e) {
        BStackLogger.debug('openRunsJournal: failed to record open run: ' + e)
    }
}

export function clearOpenRun(uuid?: string) {
    if (!uuid) {
        return
    }
    try {
        fs.rmSync(openRunFilePath(uuid), { force: true })
    } catch (e) {
        BStackLogger.debug('openRunsJournal: failed to clear open run: ' + e)
    }
}

export function collectOrphanedRuns(): TestData[] {
    const orphans: TestData[] = []
    try {
        if (!fs.existsSync(OPEN_RUNS_DIR)) {
            return orphans
        }
        for (const file of fs.readdirSync(OPEN_RUNS_DIR)) {
            try {
                orphans.push(JSON.parse(fs.readFileSync(path.join(OPEN_RUNS_DIR, file), 'utf8')))
            } catch (e) {
                BStackLogger.debug(`openRunsJournal: skipping unreadable journal file ${file}: ${e}`)
            }
        }
        fs.rmSync(OPEN_RUNS_DIR, { recursive: true, force: true })
    } catch (e) {
        BStackLogger.debug('openRunsJournal: failed to collect orphaned runs: ' + e)
    }
    return orphans
}

export async function finalizeOrphanedRuns(): Promise<number> {
    try {
        const orphans = collectOrphanedRuns()
        if (!orphans.length) {
            return 0
        }
        const finishedAt = new Date().toISOString()
        const events: UploadType[] = orphans.map((runData) => {
            const startedAtMs = runData.started_at ? new Date(runData.started_at).getTime() : NaN
            const finishedRun = {
                ...runData,
                finished_at: finishedAt,
                result: 'failed',
                duration_in_ms: Number.isNaN(startedAtMs) ? undefined : Math.max(0, Date.now() - startedAtMs),
                failure: [{ backtrace: [ORPHAN_FAILURE_REASON] }],
                failure_reason: ORPHAN_FAILURE_REASON,
                failure_type: 'UnhandledError'
            }
            // Hook payloads carry type 'hook' (same discriminator the listener uses to pick
            // the hook_run/test_run envelope key) — finalize them as HookRunFinished so the
            // backend closes the hook instead of dropping an unknown test_run uuid.
            if (runData.type === 'hook') {
                return { event_type: 'HookRunFinished', hook_run: finishedRun }
            }
            return { event_type: 'TestRunFinished', test_run: finishedRun }
        })
        await batchAndPostEvents(DATA_BATCH_ENDPOINT, 'ORPHANED_TEST_RUN_FINALIZATION', events)
        BStackLogger.info(`Finalized ${events.length} orphaned test/hook run(s) left behind by an interrupted run`)
        return events.length
    } catch (e) {
        BStackLogger.debug('openRunsJournal: failed to finalize orphaned runs: ' + e)
        return 0
    }
}
