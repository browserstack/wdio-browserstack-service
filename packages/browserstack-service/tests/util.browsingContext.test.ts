import { describe, expect, it, vi } from 'vitest'

import { overwriteBrowsingContextCommand } from '../src/util.js'

describe('overwriteBrowsingContextCommand', () => {
    const fn = async () => {}

    it('overwrites the command of every browsing context on WebdriverIO 10', () => {
        const browser = { browsingContexts: vi.fn(), overwriteCommand: vi.fn() } as unknown as WebdriverIO.Browser

        expect(overwriteBrowsingContextCommand(browser, 'execute', fn)).toBe(true)
        expect(browser.overwriteCommand).toHaveBeenCalledWith('execute', fn, { attachToBrowsingContext: true })
    })

    it('does nothing on WebdriverIO 9, which reads any third argument as "attach to elements"', () => {
        const browser = { overwriteCommand: vi.fn() } as unknown as WebdriverIO.Browser

        expect(overwriteBrowsingContextCommand(browser, 'execute', fn)).toBe(false)
        expect(browser.overwriteCommand).not.toHaveBeenCalled()
    })

    it('returns false when a browsing context has no command with this name', () => {
        const browser = {
            browsingContexts: vi.fn(),
            overwriteCommand: vi.fn().mockImplementation(() => {
                throw new Error('overwriteCommand: no browsing context command to be overwritten: url')
            })
        } as unknown as WebdriverIO.Browser

        expect(overwriteBrowsingContextCommand(browser, 'url', fn)).toBe(false)
    })
})
