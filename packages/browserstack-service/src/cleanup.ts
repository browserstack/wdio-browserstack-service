import { getErrorString, stopBuildUpstream, uploadLogs } from './util.js'
import { finalizeOrphanedRuns } from './testOps/openRunsJournal.js'
import { BStackLogger } from './bstackLogger.js'
import fs from 'node:fs'
import util from 'node:util'
import { fireFunnelRequest } from './instrumentation/funnelInstrumentation.js'
import { BROWSERSTACK_TESTHUB_UUID, BROWSERSTACK_TESTHUB_JWT, BROWSERSTACK_OBSERVABILITY } from './constants.js'
import type { FunnelData } from './types.js'
import PerformanceTester from './instrumentation/performance/performance-tester.js'

export default class BStackCleanup {
    static async startCleanup() {
        try {
            // Get funnel data object from saved file
            const funnelDataCleanup = process.argv.includes('--funnelData')
            let funnelData: FunnelData | null = null
            if (funnelDataCleanup) {
                const index = process.argv.indexOf('--funnelData')
                const filePath = process.argv[index + 1]
                funnelData = BStackCleanup.getFunnelDataFromFile(filePath)
            }
            // Snapshot before sendFunnelData — fireFunnelRequest redacts the
            // credentials in place.
            const funnelUser = funnelData?.userName
            const funnelKey = funnelData?.accessKey

            if (process.argv.includes('--observability') && funnelData) {
                await this.executeObservabilityCleanup(funnelData)
            }

            if (funnelDataCleanup && funnelData) {
                await this.sendFunnelData(funnelData)
            }

            // Rescue the SDK-log upload for runs whose launcher never reached
            // onComplete (signal termination) — after events, before exit.
            if (process.argv.includes('--uploadLogs')) {
                await this.executeLogsUpload(funnelUser, funnelKey)
            }
        } catch (err) {
            const error = err as string
            BStackLogger.error(error)
        }

        try {
            if (process.argv.includes('--performanceData')) {
                await PerformanceTester.uploadEventsData()
            }
        } catch (er) {
            BStackLogger.debug(`Error in sending events data ${util.format(er)}`)
        }
    }

    static async executeLogsUpload(funnelUser?: string, funnelKey?: string) {
        try {
            const index = process.argv.indexOf('--uploadLogs')
            const clientBuildUuid = process.argv[index + 1]
            const user = funnelUser || process.env.BROWSERSTACK_USERNAME
            const key = funnelKey || process.env.BROWSERSTACK_ACCESS_KEY
            if (!clientBuildUuid || !user || !key) {
                BStackLogger.debug('Skipping logs upload in cleanup: missing uuid or credentials')
                return
            }
            BStackLogger.debug(`Uploading SDK logs from cleanup for ${clientBuildUuid}`)
            await uploadLogs(user, key, clientBuildUuid)
        } catch (e: unknown) {
            BStackLogger.error('Error uploading SDK logs in cleanup: ' + getErrorString(e))
        }
    }
    static async executeObservabilityCleanup(funnelData: FunnelData) {
        if (!process.env[BROWSERSTACK_TESTHUB_JWT]) {
            return
        }
        BStackLogger.debug('Executing Test Reporting and Analytics cleanup')
        try {
            // SDK-4671: finalize any test runs orphaned by the interrupted process
            // before the build itself is stopped.
            await finalizeOrphanedRuns()
            const result = await stopBuildUpstream()
            if ((process.env[BROWSERSTACK_OBSERVABILITY]) && process.env[BROWSERSTACK_TESTHUB_UUID]) {
                BStackLogger.info(`\nVisit https://automation-rengg-lts.bsstag.com/builds/${process.env[BROWSERSTACK_TESTHUB_UUID]} to view build report, insights, and many more debugging information all at one place!\n`)
            }
            const status = (result && result.status) || 'failed'
            const message = (result && result.message)
            this.updateO11yStopData(funnelData, status, status === 'failed' ? message : undefined)
        } catch (e: unknown) {
            BStackLogger.error('Error in stopping Test Reporting and Analytics build: ' + e)
            this.updateO11yStopData(funnelData, 'failed', e)
        }
    }

    static updateO11yStopData(funnelData: FunnelData, status: string, error: unknown = undefined) {
        const toData = funnelData?.event_properties?.productUsage?.testObservability
        // Return if no Test Reporting and Analytics data in funnel data
        if (!toData) {
            return
        }
        let existingStopData = toData.events.buildEvents.finished
        existingStopData = existingStopData || {}

        existingStopData = {
            ...existingStopData,
            status,
            error: getErrorString(error),
            stoppedFrom: 'exitHook'
        }
        toData.events.buildEvents.finished = existingStopData
    }

    static async sendFunnelData(funnelData: FunnelData) {
        try {
            await fireFunnelRequest(funnelData)
            BStackLogger.debug('Funnel data sent successfully from cleanup')
        } catch (e: unknown) {
            BStackLogger.error('Error in sending funnel data: ' + e)
        }
    }

    static getFunnelDataFromFile(filePath: string) {
        if (!filePath) {
            return null
        }

        const content = fs.readFileSync(filePath, 'utf8')

        const data = JSON.parse(content)
        this.removeFunnelDataFile(filePath)
        return data
    }

    static removeFunnelDataFile(filePath?: string) {
        if (!filePath) {
            return
        }
        fs.rmSync(filePath, { force: true })
    }
}

void BStackCleanup.startCleanup()
