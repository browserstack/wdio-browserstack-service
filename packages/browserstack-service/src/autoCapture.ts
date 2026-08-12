import { BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS } from './constants.js'

/**
 * Opt-out for auto-captured debug logs.
 *
 * The service has uploaded its debug log for a long time, but this change puts the user's
 * HOOK SOURCE in it, so an opt-out is warranted for the first time. Name matches the Node
 * SDK's `disableAutoCaptureLogs` so the flag means the same thing across BrowserStack SDKs.
 *
 * Env var as well as the service option, because the detached cleanup process gets no
 * options object — and because CI users cannot always edit a committed config.
 */
export function isAutoCaptureLogsDisabled(options?: { disableAutoCaptureLogs?: boolean }): boolean {
    if (options?.disableAutoCaptureLogs === true) {
        return true
    }
    return String(process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS] || '').toLowerCase() === 'true'
}

/**
 * Mirror the service option onto the environment so the opt-out survives into the detached
 * cleanup process, which re-runs the log upload with no options object.
 */
export function publishAutoCaptureDisabled(options?: { disableAutoCaptureLogs?: boolean }): boolean {
    const disabled = isAutoCaptureLogsDisabled(options)
    if (disabled) {
        process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS] = 'true'
    }
    return disabled
}
