import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../../src/cli/frameworks/testFramework.js', () => ({
    default: class MockTestFramework {
        static registerObserver = vi.fn()
        static getTrackedInstance = vi.fn()
        static getState = vi.fn()
    }
}))

vi.mock('../../../src/cli/frameworks/automationFramework.js', () => ({
    default: class MockAutomationFramework {
        static registerObserver = vi.fn()
        static getTrackedInstance = vi.fn()
        static getDriver = vi.fn()
    }
}))

vi.mock('../../../src/cli/cliLogger.js', () => ({
    BStackLogger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }
}))

vi.mock('../../../src/cli/index.js', () => ({
    BrowserstackCLI: { getInstance: vi.fn() }
}))

import CustomTagsModule from '../../../src/cli/modules/customTagsModule.js'
import TestFramework from '../../../src/cli/frameworks/testFramework.js'
import AutomationFramework from '../../../src/cli/frameworks/automationFramework.js'
import WdioMochaTestFramework from '../../../src/cli/frameworks/wdioMochaTestFramework.js'
import WdioCucumberTestFramework from '../../../src/cli/frameworks/wdioCucumberTestFramework.js'
import { BrowserstackCLI } from '../../../src/cli/index.js'
import { BStackLogger } from '../../../src/cli/cliLogger.js'

/**
 * `setCustomTags` merges for the CLI-supported frameworks (mocha, cucumber) and warns and
 * no-ops when no CLI test framework is registered.
 */
describe('CustomTagsModule — framework gate', () => {
    let module: CustomTagsModule
    let browser: Record<string, unknown>
    let instance: { updateMultipleEntries: ReturnType<typeof vi.fn>, getCurrentTestState: ReturnType<typeof vi.fn> }

    const useFramework = (framework: unknown) => {
        vi.mocked(BrowserstackCLI.getInstance).mockReturnValue({
            getTestFramework: () => framework
        } as never)
    }

    beforeEach(async () => {
        vi.clearAllMocks()
        browser = {}
        instance = {
            updateMultipleEntries: vi.fn(),
            getCurrentTestState: vi.fn().mockReturnValue('TestFrameworkState.TEST')
        }
        vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue({} as never)
        vi.mocked(AutomationFramework.getDriver).mockReturnValue(browser as never)
        vi.mocked(TestFramework.getTrackedInstance).mockReturnValue(instance as never)
        vi.mocked(TestFramework.getState).mockReturnValue({} as never)

        module = new CustomTagsModule()
    })

    const register = async () => {
        await module.onBeforeExecute()
        return browser.setCustomTags as (k: string, v: string) => Promise<void>
    }

    it('registers setCustomTags regardless of framework, so the call always resolves', async () => {
        useFramework(Object.create(WdioCucumberTestFramework.prototype))
        expect(await register()).toBeTypeOf('function')
    })

    it('merges tags for mocha', async () => {
        useFramework(Object.create(WdioMochaTestFramework.prototype))
        const setCustomTags = await register()

        await setCustomTags('TC', 'TC-1,TC-2')

        expect(instance.updateMultipleEntries).toHaveBeenCalled()
    })

    it('merges tags into the current scenario for cucumber', async () => {
        useFramework(Object.create(WdioCucumberTestFramework.prototype))
        const setCustomTags = await register()

        await setCustomTags('TC', 'TC-1,TC-2')

        expect(instance.updateMultipleEntries).toHaveBeenCalledWith({
            custom_metadata: { TC: { field_type: 'multi_dropdown', values: ['TC-1', 'TC-2'] } }
        })
        expect(BStackLogger.warn).not.toHaveBeenCalled()
    })

    it('warns and no-ops when no CLI test framework is registered', async () => {
        useFramework(null)
        const setCustomTags = await register()

        await setCustomTags('TC', 'TC-1')

        expect(instance.updateMultipleEntries).not.toHaveBeenCalled()
        expect(BStackLogger.warn).toHaveBeenCalledWith(
            'setCustomTags is only supported for the mocha and cucumber frameworks; ignoring call'
        )
    })
})
