import os from 'node:os'
import util, { format } from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import UsageStats, { type UsageStat } from '../testOps/usageStats.js'
import { BStackLogger } from '../bstackLogger.js'
import type BrowserStackConfig from '../config.js'
import { BSTACK_SERVICE_VERSION, WDIO_NAMING_PREFIX } from '../constants.js'
import { getDataFromWorkers } from '../data-store.js'
import { getProductMap } from '../testHub/utils.js'
import fetchWrap from '../fetchWrapper.js'
import type { FunnelData, EventProperties } from '../types.js'
import TestOpsConfig from '../testOps/testOpsConfig.js'
import APIUtils from '../cli/apiUtils.js'
import PerformanceTester from './performance/performance-tester.js'
import { EVENTS } from './performance/constants.js'

async function fireFunnelTestEvent(eventType: string, config: BrowserStackConfig, isCLIEnabled = false) {
    if (!config.userName || !config.accessKey) {
        BStackLogger.debug('username/accesskey not passed')
        return
    }

    try {
        const data = buildEventData(eventType, config, isCLIEnabled)
        await fireFunnelRequest(data)
        BStackLogger.debug('Funnel event success')
        // Only the finish event disarms the exit-time cleanup resend — marking it
        // on SDKTestAttempted left killed runs with no SDKTestSuccessful at all.
        if (eventType === 'SDKTestSuccessful') {
            config.sentFunnelData()
        }
    } catch (error) {
        BStackLogger.debug(`Exception in sending funnel data: ${format(error)}`)
    }
}

export async function sendStart(config: BrowserStackConfig) {

    // Track funnel test attempted event
    PerformanceTester.start(EVENTS.SDK_FUNNEL_TEST_ATTEMPTED)
    try {
        await fireFunnelTestEvent('SDKTestAttempted', config)
        PerformanceTester.end(EVENTS.SDK_FUNNEL_TEST_ATTEMPTED, true)
    } catch (error) {
        PerformanceTester.end(EVENTS.SDK_FUNNEL_TEST_ATTEMPTED, false, error)
        throw error
    }
}

export async function sendFinish(config: BrowserStackConfig, isCLIEnabled = false) {
    // Track funnel test successful event
    PerformanceTester.start(EVENTS.SDK_FUNNEL_TEST_SUCCESSFUL)
    try {
        await fireFunnelTestEvent('SDKTestSuccessful', config, isCLIEnabled)
        PerformanceTester.end(EVENTS.SDK_FUNNEL_TEST_SUCCESSFUL, true)
    } catch (error) {
        PerformanceTester.end(EVENTS.SDK_FUNNEL_TEST_SUCCESSFUL, false, error)
        throw error
    }
}

export function saveFunnelData(eventType: string, config: BrowserStackConfig, isCLIEnabled = false): string {
    const data = buildEventData(eventType, config, isCLIEnabled)

    BStackLogger.ensureLogsFolder()
    const filePath = path.join(BStackLogger.logFolderPath, 'funnelData.json')
    fs.writeFileSync(filePath, JSON.stringify(data))
    return filePath
}

function redactCredentialsFromFunnelData(data: FunnelData) {
    if (data) {
        if (data.userName) {
            data.userName = '[REDACTED]'
        }
        if (data.accessKey) {
            data.accessKey = '[REDACTED]'
        }
    }
    return data
}

// Called from two different process
export async function fireFunnelRequest(data: FunnelData): Promise<void> {
    const { userName, accessKey } = data
    redactCredentialsFromFunnelData(data)

    BStackLogger.debug('Sending SDK event with data ' + util.inspect(data, { depth: 6 }))

    const encodedAuth = Buffer.from(`${userName}:${accessKey}`, 'utf8').toString('base64')
    const response = await fetchWrap(APIUtils.FUNNEL_INSTRUMENTATION_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            Authorization: `Basic ${encodedAuth}`,
        },
        body: JSON.stringify(data)
    })
    BStackLogger.debug('Funnel Event Response: ' + JSON.stringify(await response.text()))
}

function getProductList(config: BrowserStackConfig) {
    const products: string[] = []
    if (config.testObservability.enabled) {
        products.push('observability')
    }

    if (config.accessibility) {
        products.push('accessibility')
    }

    if (config.percy) {
        products.push('percy')
    }

    if (config.automate) {
        products.push('automate')
    }

    if (config.appAutomate) {
        products.push('app-automate')
    }
    return products
}

function buildEventData(eventType: string, config: BrowserStackConfig, isCLIEnabled = false) {
    const eventProperties: EventProperties = {
        // Framework Details
        sdkRunId: config?.sdkRunID,
        testhub_uuid: TestOpsConfig.getInstance().buildHashedId,
        language_framework: getLanguageFramework(config.framework),
        referrer: getReferrer(config.framework),
        language: 'WebdriverIO',
        languageVersion: process.version,

        // Build Details
        buildName: config.buildName || 'undefined',
        buildIdentifier: String(config.buildIdentifier),

        // Host details
        os: os.type() || 'unknown',
        hostname: os.hostname() || 'unknown',

        // Product Details
        productMap: getProductMap(config),
        product: getProductList(config),

        // framework details
        framework: config.framework,

        // CLI Details
        isCLIEnabled: isCLIEnabled
    }

    if (eventType === 'SDKTestSuccessful') {
        const workerData = getDataFromWorkers()
        // @ts-expect-error
        eventProperties.productUsage = getProductUsage(workerData)
        if (process.env.BSTACK_A11Y_POLLING_TIMEOUT) {
            eventProperties.pollingTimeout = process.env.BSTACK_A11Y_POLLING_TIMEOUT as string
        }
        // If any worker called browser.reloadSession(), mark the build so the
        // session-linking dashboard can exclude its (expected) reload-orphaned sessions.
        type WorkerRecord = { reloadHappened?: boolean; usageStats?: unknown }
        const reloadHappened = workerData.some((worker) => (worker as WorkerRecord).reloadHappened === true)
        if (reloadHappened) {
            eventProperties.finishedMetadata = { reason: 'session_reloaded' }
        }
        // A signal-terminated run must be query-detectable — kill wins over
        // reload as the finish reason.
        if (config.killSignal) {
            eventProperties.finishedMetadata = { reason: 'user_killed', signal: config.killSignal }
        }
    }

    return {
        userName: config.userName,
        accessKey: config.accessKey,
        event_type: eventType,
        detectedFramework: WDIO_NAMING_PREFIX + config.framework,
        event_properties: eventProperties
    } as unknown as FunnelData

}

function getProductUsage(workersData: { usageStats: UsageStat }[]) {
    return {
        testObservability: UsageStats.getInstance().getFormattedData(workersData)
    }
}

function getLanguageFramework(framework?: string) {
    return 'WebdriverIO_' + framework
}

function getReferrer(framework?: string) {
    const fullName = framework ? WDIO_NAMING_PREFIX + framework : 'WebdriverIO'
    return `${fullName}/${BSTACK_SERVICE_VERSION}`
}
