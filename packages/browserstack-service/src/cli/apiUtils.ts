import { BStackLogger } from './cliLogger.js'

export default class APIUtils {
    static FUNNEL_INSTRUMENTATION_URL = 'https://api.browserstack.com/sdk/v1/event'
    static BROWSERSTACK_AUTOMATE_API_URL = 'https://api.browserstack.com'
    static BROWSERSTACK_AA_API_URL = 'https://api.browserstack.com'
    static BROWSERSTACK_PERCY_API_URL = 'https://api.browserstack.com'
    static BROWSERSTACK_AUTOMATE_API_CLOUD_URL = 'https://api-cloud.browserstack.com'
    static BROWSERSTACK_AA_API_CLOUD_URL = 'https://api-cloud.browserstack.com'
    static APP_ALLY_ENDPOINT = 'https://app-accessibility.browserstack.com/automate'
    static DATA_ENDPOINT = 'https://collector-observability.browserstack.com'
    static UPLOAD_LOGS_ADDRESS = 'https://upload-observability.browserstack.com'
    static EDS_URL = 'https://eds.browserstack.com'

    static missingGRRUrlKeys(apis?: Partial<GRRUrls>): string[] {
        const checks: Array<[string, unknown]> = [
            ['automate.api', apis?.automate?.api],
            ['automate.upload', apis?.automate?.upload],
            ['appAutomate.api', apis?.appAutomate?.api],
            ['appAutomate.upload', apis?.appAutomate?.upload],
            ['percy.api', apis?.percy?.api],
            ['appAccessibility.api', apis?.appAccessibility?.api],
            ['observability.api', apis?.observability?.api],
            ['observability.upload', apis?.observability?.upload],
            ['edsInstrumentation.api', apis?.edsInstrumentation?.api]
        ]
        return checks.filter(([, value]) => !value).map(([key]) => key)
    }

    static updateURLSForGRR(apis?: Partial<GRRUrls>) {
        const missing = APIUtils.missingGRRUrlKeys(apis)
        if (missing.length > 0) {
            BStackLogger.warn(`updateURLSForGRR: GRR URLs incomplete — keeping default endpoints. Missing: ${missing.join(', ')}`)
            return false
        }

        // Validated above: every field read below is present. Cast is scoped to
        // this method so no unsound `apis is GRRUrls` predicate leaks to callers.
        const grrUrls = apis as GRRUrls
        this.FUNNEL_INSTRUMENTATION_URL = `${grrUrls.automate.api}/sdk/v1/event`
        this.BROWSERSTACK_AUTOMATE_API_URL = grrUrls.automate.api
        this.BROWSERSTACK_AA_API_URL = grrUrls.appAutomate.api
        this.BROWSERSTACK_PERCY_API_URL = grrUrls.percy.api
        this.BROWSERSTACK_AUTOMATE_API_CLOUD_URL = grrUrls.automate.upload
        this.BROWSERSTACK_AA_API_CLOUD_URL = grrUrls.appAutomate.upload
        this.APP_ALLY_ENDPOINT = `${grrUrls.appAccessibility.api}/automate`
        this.DATA_ENDPOINT = grrUrls.observability.api
        this.UPLOAD_LOGS_ADDRESS = grrUrls.observability.upload
        this.EDS_URL = grrUrls.edsInstrumentation.api

        return true
    }
}
