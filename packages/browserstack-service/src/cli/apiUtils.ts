export default class APIUtils {
    static FUNNEL_INSTRUMENTATION_URL = 'https://apirengg-lts.bsstag.com/sdk/v1/event'
    static BROWSERSTACK_AUTOMATE_API_URL = 'https://apirengg-lts.bsstag.com'
    static BROWSERSTACK_AA_API_URL = 'https://apirengg-lts.bsstag.com'
    static BROWSERSTACK_PERCY_API_URL = 'https://apirengg-lts.bsstag.com'
    static BROWSERSTACK_AUTOMATE_API_CLOUD_URL = 'https://api-cloud-rengg-lts.bsstag.com'
    static BROWSERSTACK_AA_API_CLOUD_URL = 'https://api-cloud-rengg-lts.bsstag.com'
    static APP_ALLY_ENDPOINT = 'https://app-accessibility-rengg-lts.bsstag.com/automate'
    static DATA_ENDPOINT = 'https://collector-observability-rengg-lts.bsstag.com'
    static UPLOAD_LOGS_ADDRESS = 'https://upload-observability-rengg-lts-ssi.bsstag.com'
    static EDS_URL = 'https://edsstaging.bsstag.com'

    static updateURLSForGRR(apis: GRRUrls) {
        this.FUNNEL_INSTRUMENTATION_URL = `${apis.automate.api}/sdk/v1/event`
        this.BROWSERSTACK_AUTOMATE_API_URL = apis.automate.api
        this.BROWSERSTACK_AA_API_URL = apis.appAutomate.api
        this.BROWSERSTACK_PERCY_API_URL = apis.percy.api
        this.BROWSERSTACK_AUTOMATE_API_CLOUD_URL = apis.automate.upload
        this.BROWSERSTACK_AA_API_CLOUD_URL = apis.appAutomate.upload
        this.APP_ALLY_ENDPOINT = `${apis.appAccessibility.api}/automate`
        this.DATA_ENDPOINT = apis.observability.api
        this.UPLOAD_LOGS_ADDRESS = apis.observability.upload
        this.EDS_URL = apis.edsInstrumentation.api
    }
}
