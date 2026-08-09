import { BStackLogger } from '../cliLogger.js'
import type { SDKClient } from '../../grpc/index.js'
import AutomationFramework from '../frameworks/automationFramework.js'
import { AutomationFrameworkConstants } from '../frameworks/constants/automationFrameworkConstants.js'
import { hasAppCap } from '../../util.js'

/**
 * Base class for BrowserStack modules
 */
export default class BaseModule {
    #name: string
    binSessionId: string|null
    platformIndex: number
    config: Record<string, unknown>
    client: SDKClient | null
    /**
     * Create a new BaseModule
     */
    constructor() {
        this.#name = 'BaseModule'
        this.binSessionId = null
        this.platformIndex = 0
        this.config = {}
        this.client = null
    }

    /**
     * Ensure that a bin session ID is available
     * @throws {Error} If binSessionId is missing
     */
    ensureBinSession() {
        if (!this.binSessionId) {
            throw new Error('Missing binSessionId')
        }
    }

    /**
     * Get the name of the module
     * @returns {string} The module name
     */
    getModuleName() {
        return this.#name
    }

    /**
     * Configure the module with session information
     * @param {string} binSessionId - The bin session ID
     * @param {number} platformIndex - The platform index
     * @param {SDKClient | null} client - The gRPC client service
     * @param {Object} config - Configuration options
     */
    configure(binSessionId: string|null, platformIndex: number, client: SDKClient | null, config = {}) {
        this.binSessionId = binSessionId
        this.platformIndex = platformIndex
        this.client = client
        this.config = config

        BStackLogger.debug(`Configured module ${this.getModuleName()} with binSessionId=${binSessionId}, platformIndex=${platformIndex}`)
    }

    // Shared App Automate detection from the tracked framework capabilities: the app cap survives
    // only in the raw INPUT capabilities (the resolved caps BrowserStack echoes back drop it), so
    // check both. Reused by AutomateModule + PercyModule to keep endpoint/product routing consistent.
    protected hasAppCapInFrameworkState(): boolean {
        const autoInstance = AutomationFramework.getTrackedInstance()
        return [AutomationFrameworkConstants.KEY_INPUT_CAPABILITIES, AutomationFrameworkConstants.KEY_CAPABILITIES]
            .some(key => hasAppCap(AutomationFramework.getState(autoInstance, key) as WebdriverIO.Capabilities | undefined))
    }
}
