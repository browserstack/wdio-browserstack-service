import InsightsHandler from '../insights-handler.js'
import TestReporter from '../reporter.js'
import { PercyLogger } from './PercyLogger.js'
import { isUndefined } from '../util.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const tryRequire = function (pkg: string, fallback: unknown) {
    try {
        const mod = require(pkg)
        if (mod && typeof mod === 'object' && 'default' in mod) {
            return (mod as { default: unknown }).default
        }
        return mod
    } catch (err) {
        PercyLogger.debug(`Percy: could not load ${pkg} - ${(err as Error)?.message}`)
        return fallback
    }
}

const percySnapshot = tryRequire('@percy/selenium-webdriver', null)

/*
Percy ships two disjoint web SDKs, and the correct one depends on the driver, not the
product. percySnapshot from @percy/selenium-webdriver drives the browser through Selenium
client APIs - executeScript(script) with a single argument, By, switchTo() - none of which
a WebdriverIO browser provides, so it captures nothing and swallows the failure. The
WebdriverIO-native port lives in @percy/webdriverio and is what `snapshot` binds to.

percyScreenshot (Percy on Automate) deliberately stays on @percy/selenium-webdriver: it is
driver-agnostic - it reads session metadata and posts, capturing server-side - and carries
an explicit wdio branch in its DriverMetadata.
*/
const percyWebdriverioSnapshot = tryRequire('@percy/webdriverio', null)

const webSnapshot = percyWebdriverioSnapshot || percySnapshot

const percyAppScreenshot = tryRequire('@percy/appium-app', {})

/*
Percy's SDKs raise their misuse guards - percySnapshot against a Percy-on-Automate build,
percyScreenshot against anything else - before their own try/catch, so those rejections
reach the caller. Every PercySDK entry point is publicly exported, so an unguarded one
fails the user's test rather than their visual coverage. PERCY_RAISE_ERROR is Percy's own
opt-in for the opposite behaviour and is honoured.
*/
const runPercy = async (label: string, call: () => unknown) => {
    try {
        return await call()
    } catch (err) {
        if (process.env.PERCY_RAISE_ERROR === 'true') {
            throw err
        }
        PercyLogger.error(`Percy ${label} failed: ${(err as Error)?.message}`)
    }
}

/* eslint-disable @typescript-eslint/no-unused-vars */
let snapshotHandler = (...args: unknown[]) => {
    PercyLogger.error('Unsupported driver for percy')
}
if (webSnapshot) {
    snapshotHandler = async (browser: WebdriverIO.Browser | WebdriverIO.MultiRemoteBrowser, snapshotName: string, options?: { [key: string]: unknown }) => {
        if (process.env.PERCY_SNAPSHOT === 'true') {
            let { name, uuid } = InsightsHandler.currentTest
            if (isUndefined(name)) {
                ({ name, uuid } = TestReporter.currentTest)
            }
            options ||= {}
            options = {
                ...options,
                testCase: name || ''
            }
            return await runPercy(`snapshot "${snapshotName}"`, () => webSnapshot(browser, snapshotName, options))
        }
    }
}
export const snapshot = snapshotHandler

/*
This is a helper method which appends some internal fields
to the options object being sent to Percy methods
*/
const screenshotHelper = (type: string, driverOrName: WebdriverIO.Browser | WebdriverIO.MultiRemoteBrowser | string, nameOrOptions?: string | { [key: string]: unknown }, options?: { [key: string]: unknown }) => {
    let { name, uuid } = InsightsHandler.currentTest
    if (isUndefined(name)) {
        ({ name, uuid } = TestReporter.currentTest)
    }
    if (!driverOrName || typeof driverOrName === 'string') {
        nameOrOptions ||= {}
        if (typeof nameOrOptions === 'object') {
            nameOrOptions = {
                ...nameOrOptions,
                testCase: name || ''
            }
        }
    } else {
        options ||= {}
        options = {
            ...options,
            testCase: name || ''
        }
    }
    if (type === 'app') {
        return percyAppScreenshot(driverOrName, nameOrOptions, options)
    }
    return percySnapshot.percyScreenshot(driverOrName, nameOrOptions, options)
}

/* eslint-disable @typescript-eslint/no-unused-vars */
let screenshotHandler = async (...args: unknown[]): Promise<unknown> => {
    PercyLogger.error('Unsupported driver for percy')
    return undefined
}
if (percySnapshot && percySnapshot.percyScreenshot) {
    screenshotHandler = async (browser: WebdriverIO.Browser | WebdriverIO.MultiRemoteBrowser | string, screenshotName?: string | { [key: string]: unknown }, options?: { [key: string]: unknown }) => {
        return await runPercy('screenshot', () => screenshotHelper('web', browser, screenshotName, options))
    }
}
export const screenshot = screenshotHandler

/* eslint-disable @typescript-eslint/no-unused-vars */
let screenshotAppHandler = async (...args: unknown[]): Promise<unknown> => {
    PercyLogger.error('Unsupported driver for percy')
    return undefined
}
if (percyAppScreenshot) {
    screenshotAppHandler = async (driverOrName: WebdriverIO.Browser | WebdriverIO.MultiRemoteBrowser | string, nameOrOptions?: string | { [key: string]: unknown }, options?: { [key: string]: unknown }) => {
        return await runPercy('app screenshot', () => screenshotHelper('app', driverOrName, nameOrOptions, options))
    }
}
export const screenshotApp = screenshotAppHandler