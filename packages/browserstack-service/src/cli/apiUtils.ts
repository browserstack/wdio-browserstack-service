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

    /**
     * Overlay the binary-supplied GRR endpoints onto the public defaults. Every field is
     * optional: a degenerate StartBinSession/ConnectBinSession config (auth failure, empty
     * payload) used to throw here and abort the whole CLI bootstrap, taking every product
     * module with it. Missing entries now just leave the corresponding default in place.
     */
    static updateURLSForGRR(apis?: GRRUrls) {
        if (!apis) {
            return
        }
        if (apis.automate?.api) {
            this.FUNNEL_INSTRUMENTATION_URL = `${apis.automate.api}/sdk/v1/event`
            this.BROWSERSTACK_AUTOMATE_API_URL = apis.automate.api
        }
        if (apis.automate?.upload) {
            this.BROWSERSTACK_AUTOMATE_API_CLOUD_URL = apis.automate.upload
        }
        if (apis.appAutomate?.api) {
            this.BROWSERSTACK_AA_API_URL = apis.appAutomate.api
        }
        if (apis.appAutomate?.upload) {
            this.BROWSERSTACK_AA_API_CLOUD_URL = apis.appAutomate.upload
        }
        if (apis.percy?.api) {
            this.BROWSERSTACK_PERCY_API_URL = apis.percy.api
        }
        if (apis.appAccessibility?.api) {
            this.APP_ALLY_ENDPOINT = `${apis.appAccessibility.api}/automate`
        }
        if (apis.observability?.api) {
            this.DATA_ENDPOINT = apis.observability.api
        }
        if (apis.observability?.upload) {
            this.UPLOAD_LOGS_ADDRESS = apis.observability.upload
        }
        if (apis.edsInstrumentation?.api) {
            this.EDS_URL = apis.edsInstrumentation.api
        }
    }
}
