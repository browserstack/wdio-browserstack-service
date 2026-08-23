import type { BrowserstackConfig } from './types.js'
import pkg from '../package.json' with { type: 'json' }

const bstackServiceVersion = pkg.version

export const BROWSER_DESCRIPTION = [
    'device',
    'os',
    'osVersion',
    'os_version',
    'browserName',
    'browser',
    'browserVersion',
    'browser_version'
] as const

export const VALID_APP_EXTENSION = [
    '.apk',
    '.aab',
    '.ipa'
]

export const DEFAULT_OPTIONS: Partial<BrowserstackConfig> = {
    setSessionName: true,
    setSessionStatus: true,
    testObservability: true
}

export const consoleHolder: typeof console = Object.assign({}, console)

export const DATA_ENDPOINT = 'https://collector-testhub-rengg-lts-external.bsstag.com'
export const APP_ALLY_ENDPOINT = 'https://app-accessibility-rengg-lts.bsstag.com/automate'
export const APP_ALLY_ISSUES_ENDPOINT = 'api/v1/issues'
export const APP_ALLY_ISSUES_SUMMARY_ENDPOINT = 'api/v1/issues-summary'
export const DATA_EVENT_ENDPOINT = 'api/v1/event'
export const DATA_BATCH_ENDPOINT = 'api/v1/batch'
export const DATA_SCREENSHOT_ENDPOINT = 'api/v1/screenshots'
export const DATA_BATCH_SIZE = 1000
export const DATA_BATCH_INTERVAL = 2000
export const BATCH_EVENT_TYPES = ['LogCreated', 'TestRunStarted', 'TestRunFinished', 'HookRunFinished', 'HookRunStarted', 'ScreenshotCreated']
export const DEFAULT_WAIT_TIMEOUT_FOR_PENDING_UPLOADS = 5000 // 5s
export const DEFAULT_WAIT_INTERVAL_FOR_PENDING_UPLOADS = 100 // 100ms
export const BSTACK_SERVICE_VERSION = bstackServiceVersion

export const NOT_ALLOWED_KEYS_IN_CAPS = ['includeTagsInTestingScope', 'excludeTagsInTestingScope', 'testManagementOptions', 'skipAppOverride']
export const BROWSERSTACK_TEST_PLAN_ID = 'BROWSERSTACK_TEST_PLAN_ID'

export const LOGS_FILE = 'logs/bstack-wdio-service.log'
export const CLI_DEBUG_LOGS_FILE = 'log/sdk-cli-debug.log'
export const UPLOAD_LOGS_ADDRESS = 'https://upload-observability-rengg-lts-ssi.bsstag.com'
export const UPLOAD_LOGS_ENDPOINT = 'client-logs/upload'

export const PERCY_LOGS_FILE = 'logs/percy.log'

/**
 * Auto-capture of the user's wdio config file (SDK-7250).
 */

/*
 * Shown once per run when auto-capture is active. The Node SDK does the same
 * (BrowserStackSetup.js -> AUTOLOGCAPTURE_NOTIFICATION); without it a wdio customer gets no
 * runtime disclosure that their config file is collected, only a changeset entry and a JSDoc
 * comment. Since the redaction is key-name driven and best-effort, the notice is part of the
 * control rather than decoration.
 */
export const AUTOLOGCAPTURE_NOTIFICATION = 'Your wdio config file, the local config files it imports and package.json are captured with the debug logs at the end of the run, with values under known credential keys removed. To disable, set disableAutoCaptureLogs: true in the browserstack service options.'

/* Absolute path of the resolved wdio config, published once so the upload path never re-derives it */
export const BROWSERSTACK_WDIO_CONFIG_FILE_PATH = 'BROWSERSTACK_WDIO_CONFIG_FILE_PATH'
export const BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS = 'BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS'
/* Which ladder rung resolved the config, kept so the upload path reports the TRUE rung
   instead of re-reading its own env var and always saying 'env_override' */
export const BROWSERSTACK_WDIO_CONFIG_STRATEGY = 'BROWSERSTACK_WDIO_CONFIG_STRATEGY'

/* Mirrors create-wdio's SUPPORTED_CONFIG_FILE_EXTENSION (identical in wdio v8 and v9) */
export const SUPPORTED_WDIO_CONFIG_EXTENSIONS = ['.js', '.ts', '.mjs', '.mts', '.cjs', '.cts']
export const DEFAULT_WDIO_CONFIG_BASENAME = 'wdio.conf'
/* `wdio <cmd>` verbs that must never be mistaken for the config positional */
export const WDIO_CLI_SUBCOMMANDS = ['run', 'install', 'repl', 'config']

/* Configs are kilobytes; the cap only exists so a mislabelled path cannot bloat the archive */
export const MAX_CAPTURED_CONFIG_FILE_BYTES = 1024 * 1024
export const MAX_CAPTURED_CONFIG_FILES = 6
/* How far to follow relative imports out of the entry config (1 = direct imports only) */
export const CAPTURE_CONFIG_IMPORT_DEPTH = 1
/* How far to walk up from the config dir looking for the project's package.json */
export const MAX_PACKAGE_JSON_WALK_UP = 5

/**
 * Keys whose line is scrubbed before a config file enters the archive.
 * `user` / `key` are WDIO's own top-level credential options, hence the bare entries.
 */
/**
 * Word families that make an identifier sensitive when they appear as its SUFFIX —
 * `clientSecret`, `refreshToken`, `privateKey`, `client_secret`. Split by case so the
 * camelCase form requires a capital (distinguishing `privateKey` from `hotkey`) and the
 * snake_case form requires an explicit `_` (distinguishing `client_secret` from `keyword`).
 */
export const COMPOUND_SECRET_SUFFIXES_CAMEL = 'Key|Token|Secret|Password|Passwd|Credential'
export const COMPOUND_SECRET_SUFFIXES_SNAKE = 'key|token|secret|password|passwd|credential'

/**
 * Secrets that span lines or hide inside a value, which a line/key-anchored scrub cannot
 * reach. Applied as whole-block passes before the line passes.
 */
/* an inline PEM: the key bytes sit on lines that carry no key name at all */
/*
 * The body is TEMPERED so it cannot cross a second `-----BEGIN`: with a plain `[\s\S]*?`,
 * an UNTERMINATED block earlier in the file matches through to a later, unrelated block's
 * END marker and everything in between is replaced — silently destroying unrelated config.
 * Bounded as well, so the scan stays linear.
 */
export const PEM_BLOCK_REGEX = /(-----BEGIN [^-\r\n]+-----)(?:(?!-----BEGIN)[\s\S]){0,65536}?(-----END [^-\r\n]+-----)/g
/*
 * A PEM opened but never closed. The block regex above needs the END marker, so without it
 * the key bytes survive every pass. Matched as BEGIN + the run of base64-only lines that
 * follows. A run must be at least 20 characters and end at a non-base64 character: letters
 * are valid base64, so a shorter/unbounded rule matches part of an ordinary line such as
 * `nextOption: 1` and eats it. Stops at the first line that does not qualify, so a malformed
 * block cannot swallow the rest of the file. The upper bound is generous (8 KB) because a
 * key written unwrapped on ONE line would otherwise exceed it and fail OPEN, leaving the body
 * in the bundle.
 */
export const PEM_UNTERMINATED_REGEX = /(-----BEGIN [^-\r\n]+-----)(?:\r?\n[A-Za-z0-9+/=]{20,8192}(?=[^A-Za-z0-9+/=]|$))+/g
/*
 * Userinfo in ANY url value, not just the `proxyUrl` key. The password half is optional so
 * single-token forms (`https://ghp_xxx@github.com`, common in CI git/npm remotes) are caught
 * too. Quantifiers are BOUNDED: the unbounded form was measurably quadratic (100 KB of
 * word characters took 6.1 s, 4x per doubling) because both halves scan forward for an `@`
 * that never arrives. Real userinfo is short, so the bounds change no real-world match.
 */
export const URL_USERINFO_REGEX = /([a-zA-Z][a-zA-Z0-9+.-]{0,64}:\/\/)[^\s/@:]{1,256}(?::[^\s/@]{0,256})?@/g

export const REDACTED_KEYS = [
    'user', 'key',
    'userName', 'accessKey',
    'browserstack.user', 'browserstack.key',
    'browserstack.userName', 'browserstack.accessKey',
    'password', 'proxyPassword', 'proxyUser', 'proxyPass',
    'localProxyUser', 'localProxyPass', 'proxyUrl',
    'authToken', 'apiKey', 'accessToken', 'secret', 'token',
    'customVariables', 'user_data', 'httpProxy', 'httpsProxy'
]

export const PERCY_DOM_CHANGING_COMMANDS_ENDPOINTS = [
    '/session/:sessionId/url',
    '/session/:sessionId/forward',
    '/session/:sessionId/back',
    '/session/:sessionId/refresh',
    '/session/:sessionId/screenshot',
    '/session/:sessionId/actions',
    '/session/:sessionId/appium/device/shake'
]

export const CAPTURE_MODES = ['click', 'auto', 'screenshot', 'manual', 'testcase']
export const LOG_KIND_USAGE_MAP = {
    'TEST_LOG': 'log',
    'TEST_SCREENSHOT': 'screenshot',
    'TEST_STEP': 'step',
    'HTTP': 'http'
}

export const FUNNEL_INSTRUMENTATION_URL = 'https://apirengg-lts.bsstag.com/sdk/v1/event'

export const EDS_URL = 'https://edsstaging.bsstag.com'

export const SUPPORTED_BROWSERS_FOR_AI = ['chrome', 'microsoftedge', 'firefox']

export const TCG_URL = 'https://tcg.bsstag.com'

export const TCG_INFO = {
    tcgRegion: 'use',
    tcgUrl: TCG_URL,
}

// Smart Selection Mode Constants
export const SMART_SELECTION_MODE_RELEVANT_FIRST = 'relevantFirst'
export const SMART_SELECTION_MODE_RELEVANT_ONLY = 'relevantOnly'

// Env variables - Define all the env variable constants over here

// To store the JWT token returned the session launch
export const BROWSERSTACK_TESTHUB_JWT = 'BROWSERSTACK_TESTHUB_JWT'

// To store tcg auth result for selfHealing feature:
export const BSTACK_TCG_AUTH_RESULT = 'BSTACK_TCG_AUTH_RESULT'

// To store the setting of whether to send screenshots or not
export const TESTOPS_SCREENSHOT_ENV = 'BS_TESTOPS_ALLOW_SCREENSHOTS'

// To store build hashed id
export const BROWSERSTACK_TESTHUB_UUID = 'BROWSERSTACK_TESTHUB_UUID'
// Interrupt signal, propagated via env so the detached cleanup child and gRPC
// stop path can stamp the kill reason onto the build stop.
export const BROWSERSTACK_KILL_SIGNAL = 'BROWSERSTACK_SDK_KILL_SIGNAL'

// To store test run uuid
export const TEST_ANALYTICS_ID = 'TEST_ANALYTICS_ID'

// Whether to collect performance instrumentation or not
export const PERF_MEASUREMENT_ENV = 'BROWSERSTACK_O11Y_PERF_MEASUREMENT'

// Whether the current run is rerun or not
export const RERUN_TESTS_ENV = 'BROWSERSTACK_RERUN_TESTS'

// The tests that needs to be rerun
export const RERUN_ENV = 'BROWSERSTACK_RERUN'

// To store whether the build launch has completed or not
export const TESTOPS_BUILD_COMPLETED_ENV = 'BS_TESTOPS_BUILD_COMPLETED'

// Whether percy has started successfully or not
export const BROWSERSTACK_PERCY = 'BROWSERSTACK_PERCY'

// Whether session is a accessibility session
export const BROWSERSTACK_ACCESSIBILITY = 'BROWSERSTACK_ACCESSIBILITY'

// Whether session is a test reporting session
export const BROWSERSTACK_OBSERVABILITY = 'BROWSERSTACK_OBSERVABILITY'

// Load Testing Service (LTS) env vars: the pod-iteration session id (its
// presence is the single source of truth for "this run is an LTS pod
// iteration") and an optional opt-in flag for local repro / CI runs that
// don't have a real session id.
export const BROWSERSTACK_LTS_SESSION_ID = 'BROWSERSTACK_LTS_SESSION_ID'
export const BROWSERSTACK_LTS = 'BROWSERSTACK_LTS'

// New Test Reporting and Analytics environment variables
export const BROWSERSTACK_TEST_REPORTING = 'BROWSERSTACK_TEST_REPORTING'
export const BROWSERSTACK_TEST_REPORTING_DEBUG = 'BROWSERSTACK_TEST_REPORTING_DEBUG'
export const TEST_REPORTING_BUILD_TAG = 'TEST_REPORTING_BUILD_TAG'
export const TEST_REPORTING_PROJECT_NAME = 'TEST_REPORTING_PROJECT_NAME'
export const TEST_REPORTING_BUILD_NAME = 'TEST_REPORTING_BUILD_NAME'

// Maximum size of VCS info which is allowed
export const MAX_GIT_META_DATA_SIZE_IN_BYTES = 64 * 1024

/* The value to be appended at the end if git metadata is larger than MAX_GIT_META_DATA_SIZE_IN_BYTES
*/
export const GIT_META_DATA_TRUNCATED = '...[TRUNCATED]'

// CLI related constants
export const CLI_STOP_TIMEOUT = 5000 // 5 seconds
export const BINARY_BUSY_ERROR_CODES = ['ETXTBSY', 'EBUSY']
export const MAX_SPAWN_RETRIES = 3
export const SPAWN_RETRY_DELAY_MS = 1000
export const WDIO_NAMING_PREFIX = 'WebdriverIO-'
export const PERF_METRICS_WAIT_TIME = 2000

// Build-stop delivery budget. The stop PUT is the only signal that closes a TRA build,
// so a transient transport failure is worth retrying past a short network blip — but the
// whole thing runs during shutdown, so the total cost is capped by a wall-clock deadline
// rather than by attempt count alone.
export const STOP_BUILD_MAX_ATTEMPTS = 4
export const STOP_BUILD_ATTEMPT_TIMEOUT_MS = 10000
export const STOP_BUILD_TOTAL_BUDGET_MS = 30000
export const STOP_BUILD_BACKOFF_BASE_MS = 1000

// API Endpoint constants
export const UPDATED_CLI_ENDPOINT = 'sdk/v1/update_cli'

/**
 * Module Hook Events - Performance event names for module lifecycle tracking
 * Used by module-hook-tracker.ts to instrument module initialization and cleanup
 */
export const MODULE_HOOK_EVENTS = {
    // Instrumentation module
    INSTRUMENTATION_ON_START: 'MODULE_INSTRUMENTATION_ON_START',
    INSTRUMENTATION_ON_STOP: 'MODULE_INSTRUMENTATION_ON_STOP',

    // TestHub module
    TESTHUB_ON_START: 'MODULE_TESTHUB_ON_START',
    TESTHUB_ON_STOP: 'MODULE_TESTHUB_ON_STOP',

    // Observability module
    OBSERVABILITY_ON_START: 'MODULE_OBSERVABILITY_ON_START',
    OBSERVABILITY_ON_STOP: 'MODULE_OBSERVABILITY_ON_STOP',

    // Percy module
    PERCY_ON_START: 'MODULE_PERCY_ON_START',
    PERCY_ON_STOP: 'MODULE_PERCY_ON_STOP',

    // Accessibility module
    ACCESSIBILITY_ON_START: 'MODULE_ACCESSIBILITY_ON_START',
    ACCESSIBILITY_ON_STOP: 'MODULE_ACCESSIBILITY_ON_STOP',
    ACCESSIBILITY_ON_DRIVER_INIT: 'MODULE_ACCESSIBILITY_ON_DRIVER_INIT',

    // AI module
    AI_ON_START: 'MODULE_AI_ON_START',
    AI_ON_STOP: 'MODULE_AI_ON_STOP',
    AI_BEFORE_SESSION: 'MODULE_AI_BEFORE_SESSION',
    AI_ON_DRIVER_INIT: 'MODULE_AI_ON_DRIVER_INIT',

    // Local testing module
    LOCAL_ON_START: 'MODULE_LOCAL_ON_START',
    LOCAL_ON_STOP: 'MODULE_LOCAL_ON_STOP',
    LOCAL_INIT_SESSION: 'MODULE_LOCAL_INIT_SESSION',
    LOCAL_ON_DRIVER_INIT: 'MODULE_LOCAL_ON_DRIVER_INIT',

    // App Automate module
    APPAUTOMATE_ON_START: 'MODULE_APPAUTOMATE_ON_START',
    APPAUTOMATE_ON_DRIVER_INIT: 'MODULE_APPAUTOMATE_ON_DRIVER_INIT',
} as const
