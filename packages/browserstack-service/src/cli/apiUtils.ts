export default class APIUtils {
    static FUNNEL_INSTRUMENTATION_URL = 'https://apirengg-lts.bsstag.com/sdk/v1/event'
    static BROWSERSTACK_AUTOMATE_API_URL = 'https://apirengg-lts.bsstag.com'
    static BROWSERSTACK_AA_API_URL = 'https://apirengg-lts.bsstag.com'
    static BROWSERSTACK_PERCY_API_URL = 'https://apirengg-lts.bsstag.com'
    static BROWSERSTACK_AUTOMATE_API_CLOUD_URL = 'https://api-cloud-rengg-lts.bsstag.com'
    static BROWSERSTACK_AA_API_CLOUD_URL = 'https://api-cloud-rengg-lts.bsstag.com'
    static APP_ALLY_ENDPOINT = 'https://app-accessibility-rengg-lts.bsstag.com/automate'
    static DATA_ENDPOINT = 'https://collector-testhub-rengg-lts-external.bsstag.com'
    static UPLOAD_LOGS_ADDRESS = 'https://upload-observability-rengg-lts-ssi.bsstag.com'
    static EDS_URL = 'https://edsstaging.bsstag.com'

    static updateURLSForGRR(apis: GRRUrls) {
        // Per-field null-guard: the reg CLI binary (browserstack/browserstack-binary
        // LTS-daily-reg-binary)'s StartBinSession response doesn't include the
        // full apis schema this method expects. Without guards it throws
        // "Cannot read properties of undefined (reading 'automate' | 'appAutomate'
        // | 'percy' | 'appAccessibility' | 'observability' | 'edsInstrumentation')"
        // and bootstrap fails, no build is created, no BTCER row lands.
        // Fall back to the baked-in reg URLs (top of file) for any missing subtree.
        // Prod's CLI binary returns the full schema — every guard falls through.
        if (apis?.automate?.api) {
            this.FUNNEL_INSTRUMENTATION_URL = `${apis.automate.api}/sdk/v1/event`
            this.BROWSERSTACK_AUTOMATE_API_URL = apis.automate.api
        }
        if (apis?.appAutomate?.api) {
            this.BROWSERSTACK_AA_API_URL = apis.appAutomate.api
        }
        if (apis?.percy?.api) {
            this.BROWSERSTACK_PERCY_API_URL = apis.percy.api
        }
        if (apis?.automate?.upload) {
            this.BROWSERSTACK_AUTOMATE_API_CLOUD_URL = apis.automate.upload
        }
        if (apis?.appAutomate?.upload) {
            this.BROWSERSTACK_AA_API_CLOUD_URL = apis.appAutomate.upload
        }
        if (apis?.appAccessibility?.api) {
            this.APP_ALLY_ENDPOINT = `${apis.appAccessibility.api}/automate`
        }
        if (apis?.observability?.api) {
            this.DATA_ENDPOINT = apis.observability.api
        }
        if (apis?.observability?.upload) {
            this.UPLOAD_LOGS_ADDRESS = apis.observability.upload
        }
        if (apis?.edsInstrumentation?.api) {
            this.EDS_URL = apis.edsInstrumentation.api
        }
    }
}
