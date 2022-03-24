import type { Browser, MultiRemoteBrowser } from 'webdriverio'
import type { Capabilities } from '@wdio/types'

import { BROWSER_DESCRIPTION } from './constants'

// @ts-ignore
import { version } from '../package.json'

/**
 * get browser description for Browserstack service
 * @param cap browser capablities
 */
export function getBrowserDescription(cap: Capabilities.DesiredCapabilities) {
    cap = cap || {}
    if (cap['bstack:options']) {
        cap = { ...cap, ...cap['bstack:options'] } as Capabilities.DesiredCapabilities
    }

    /**
     * These keys describe the browser the test was run on
     */
    return BROWSER_DESCRIPTION
        .map((k: keyof Capabilities.DesiredCapabilities) => cap[k])
        .filter(Boolean)
        .join(' ')
}

/**
 * get correct browser capabilities object in both multiremote and normal setups
 * @param browser browser object
 * @param caps browser capbilities object. In case of multiremote, the object itself should have a property named 'capabilities'
 * @param browserName browser name in case of multiremote
 */
export function getBrowserCapabilities(browser: Browser<'async'> | MultiRemoteBrowser<'async'>, caps?: Capabilities.RemoteCapability, browserName?: string) {
    if (!browser.isMultiremote) {
        return { ...browser.capabilities, ...caps }
    }

    const multiCaps = caps as Capabilities.MultiRemoteCapabilities
    const globalCap = browserName && browser[browserName] ? browser[browserName].capabilities : {}
    const cap = browserName && multiCaps[browserName] ? multiCaps[browserName].capabilities : {}
    return { ...globalCap, ...cap } as Capabilities.Capabilities
}

/**
 * check for browserstack W3C capabilities. Does not support legacy capabilities
 * @param cap browser capabilities
 */
export function isBrowserstackCapability(cap?: Capabilities.Capabilities) {
    return Boolean(cap && cap['bstack:options'])
}

export function getParentSuiteName(fullTitle: string, testSuiteTitle: string): string {
    const fullTitleWords = fullTitle.split(' ')
    const testSuiteTitleWords = testSuiteTitle.split(' ')
    const shortestLength = Math.min(fullTitleWords.length, testSuiteTitleWords.length)
    let c = 0
    let parentSuiteName = ''
    while (c < shortestLength && fullTitleWords[c] === testSuiteTitleWords[c]) {
        parentSuiteName += fullTitleWords[c++] + ' '
    }
    return parentSuiteName.trim()
}

// returns the webdriverIO version being used
export function getWebdriverIOVersion(): any {
    let webdriverIOVersion: any = undefined;
    // process.env.npm_package_json returns the path of the package.json file
    const packageFile: any = process.env.npm_package_json;
    if (packageFile !== undefined) {
        // try to get the webdriverIO version from the dependencies
        const { devDependencies, dependencies } = require(packageFile);
        if (devDependencies !== undefined) {
            webdriverIOVersion = devDependencies['webdriverio']
        }
        if (webdriverIOVersion !== undefined && dependencies !== undefined) {
            webdriverIOVersion = dependencies['webdriverio']
        }
    } else {
        // for node version > 12 process.env.npm_package_json is undefined
        // we directly have access to the dependencies, using that here
        webdriverIOVersion = process.env.npm_package_dependencies_webdriverio;
        if (webdriverIOVersion === undefined) {
            webdriverIOVersion = process.env.npm_package_devDependencies_webdriverio;
        }
    }
    if (webdriverIOVersion !== undefined) {
        // calculate the major version of the webdriverio package
        webdriverIOVersion = webdriverIOVersion.split('.')[0];
        if (webdriverIOVersion[0] === '^') {
            webdriverIOVersion = webdriverIOVersion.substring(1);
        }
        webdriverIOVersion = parseInt(webdriverIOVersion);
    }
    return webdriverIOVersion;
}

// import the version from package.json file and return it
export function getBrowserstackWdioServiceVersion(): string {
    return version;
}
