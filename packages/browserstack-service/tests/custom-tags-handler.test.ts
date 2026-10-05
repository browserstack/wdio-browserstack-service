import { describe, expect, it } from 'vitest'

import CustomTagsHandler from '../src/custom-tags-handler.js'

describe('CustomTagsHandler.before', () => {
    const multiRemoteBrowser = (flags: Record<string, boolean>) => {
        const instances: Record<string, Record<string, unknown>> = { browserA: {}, browserB: {} }
        return {
            browser: { ...flags, getInstance: (name: string) => instances[name] } as Record<string, unknown>,
            instances
        }
    }

    it('registers setCustomTags on each instance of a WebdriverIO v10 multiremote browser', () => {
        const { browser, instances } = multiRemoteBrowser({ isMultiRemote: true })

        new CustomTagsHandler(browser as any, { browserA: {}, browserB: {} }, 'mocha').before()

        expect(browser.setCustomTags).toEqual(expect.any(Function))
        expect(instances.browserA.setCustomTags).toEqual(expect.any(Function))
        expect(instances.browserB.setCustomTags).toEqual(expect.any(Function))
    })

    it('registers setCustomTags on each instance of a WebdriverIO v9 multiremote browser', () => {
        const { browser, instances } = multiRemoteBrowser({ isMultiremote: true })

        new CustomTagsHandler(browser as any, { browserA: {}, browserB: {} }, 'mocha').before()

        expect(instances.browserA.setCustomTags).toEqual(expect.any(Function))
        expect(instances.browserB.setCustomTags).toEqual(expect.any(Function))
    })

    it('registers setCustomTags on a single browser only', () => {
        const { browser, instances } = multiRemoteBrowser({ isMultiRemote: false })

        new CustomTagsHandler(browser as any, { browserName: 'chrome' }, 'mocha').before()

        expect(browser.setCustomTags).toEqual(expect.any(Function))
        expect(instances.browserA.setCustomTags).toBeUndefined()
    })
})
