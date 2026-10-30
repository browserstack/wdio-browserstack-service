import os from 'node:os'
import util from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import got from 'got'
import UsageStats from '../testOps/usageStats.js'
import TestOpsConfig from '../testOps/testOpsConfig.js'
import { BStackLogger } from '../bstackLogger.js'
import type BrowserStackConfig from '../config.js'
import { BSTACK_A11Y_POLLING_TIMEOUT, BSTACK_SERVICE_VERSION, WDIO_NAMING_PREFIX } from '../constants.js'
import { getDataFromWorkers, removeWorkersDataDir } from '../data-store.js'
import { getProductMap } from '../testHub/utils.js'
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
        if (eventType === 'SDKTestSuccessful') {
            config.sentFunnelData()
        }
    } catch (error) {
        BStackLogger.debug('Exception in sending funnel data: ' + error)
    }
}

export async function sendStart(config: BrowserStackConfig) {
    // Remove Workers folder if exists
    removeWorkersDataDir()

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

function redactCredentialsFromFunnelData(data: any) {
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
export async function fireFunnelRequest(data: any): Promise<void> {
    const { userName, accessKey } = data
    redactCredentialsFromFunnelData(data)
    BStackLogger.debug('Sending SDK event with data ' + util.inspect(data, { depth: 6 }))
    await got.post(APIUtils.FUNNEL_INSTRUMENTATION_URL, {
        headers: {
            'content-type': 'application/json'
        }, username: userName, password: accessKey, json: data
    })
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

function buildEventData(eventType: string, config: BrowserStackConfig, isCLIEnabled = false): any {
    const eventProperties: any = {
        // Framework Details
        language_framework: getLanguageFramework(config.framework),
        referrer: getReferrer(config.framework),
        language: 'WebdriverIO',
        languageVersion: process.version,

        // Build Details
        buildName: config.buildName || 'undefined',
        buildIdentifier: String(config.buildIdentifier),
        sdkRunId: config.sdkRunID,

        // Host details
        os: os.type() || 'unknown',
        hostname: os.hostname() || 'unknown',

        // Product Details
        productMap: getProductMap(config),
        product: getProductList(config),

        // framework details
        framework: config.framework,

        // CLI details
        isCLIEnabled: isCLIEnabled,
    }
    if (TestOpsConfig.getInstance().buildHashedId) {
        eventProperties.testhub_uuid = TestOpsConfig.getInstance().buildHashedId
    }

    if (eventType === 'SDKTestSuccessful') {
        const workerData = getDataFromWorkers()
        eventProperties.productUsage = getProductUsage(workerData)
        eventProperties.isPercyAutoEnabled = config.isPercyAutoEnabled
        eventProperties.percyBuildId = config.percyBuildId
        if (process.env[BSTACK_A11Y_POLLING_TIMEOUT]) {
            eventProperties.pollingTimeout = process.env[BSTACK_A11Y_POLLING_TIMEOUT]
        }
        if (config.killSignal) {
            eventProperties.finishedMetadata = {
                reason: 'user_killed',
                signal: config.killSignal
            }
        }
    }

    return {
        userName: config.userName,
        accessKey: config.accessKey,
        event_type: eventType,
        detectedFramework: WDIO_NAMING_PREFIX + config.framework,
        event_properties: eventProperties
    }

}

function getProductUsage(workersData: any[]) {
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

const sendEvent = {
    tcgDown: (config: BrowserStackConfig) => fireFunnelTestEvent('SDKTestTcgDownResponse', config),
    invalidTcgAuth: (config: BrowserStackConfig) => fireFunnelTestEvent('SDKTestInvalidTcgAuthResponseWithUserImpact', config),
    tcgAuthFailure: (config: BrowserStackConfig) => fireFunnelTestEvent('SDKTestTcgAuthFailure', config),
    tcgtInitSuccessful: (config: BrowserStackConfig) => fireFunnelTestEvent('SDKTestTcgtInitSuccessful', config),
    initFailed: (config: BrowserStackConfig) => fireFunnelTestEvent('SDKTestInitFailedResponse', config),
}
