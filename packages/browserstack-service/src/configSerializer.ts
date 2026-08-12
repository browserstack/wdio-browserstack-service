import {
    COMPOUND_SECRET_SUFFIXES_CAMEL,
    COMPOUND_SECRET_SUFFIXES_SNAKE,
    PEM_BLOCK_REGEX,
    PEM_UNTERMINATED_REGEX,
    REDACTED_KEYS,
    URL_USERINFO_REGEX
} from './constants.js'

/**
 * Safe, lossless-enough serialization of the user's wdio config for the debug log.
 *
 * The log already carries a config dump, but `JSON.parse(JSON.stringify(config))` loses
 * exactly the parts that matter most when triaging: every hook serialises to `null`
 * (`before: [null]`), `RegExp` values collapse to `{}`, and a circular reference — which
 * plugins and reporters do produce — throws outright, in the service constructor, with no
 * try/catch around it.
 *
 * This replaces that with a replacer that keeps function source, keeps RegExp, survives
 * cycles, and scrubs credentials on the way out.
 */

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/* whole-word key match: `key`, `accessKey`, `browserstack.user`, … */
const WHOLE_WORD_KEY_REGEX = new RegExp(
    `^(?:${[...REDACTED_KEYS].sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})$`,
    'i'
)
/* compound key match: `clientSecret` (camelCase) and `client_secret` / `CLIENT_SECRET` */
const COMPOUND_CAMEL_KEY_REGEX = new RegExp(`^[A-Za-z0-9_$]{0,64}[a-z0-9](?:${COMPOUND_SECRET_SUFFIXES_CAMEL})$`)
const COMPOUND_SNAKE_KEY_REGEX = new RegExp(`^[A-Za-z0-9_$]{0,64}_(?:${COMPOUND_SECRET_SUFFIXES_SNAKE})$`, 'i')

/**
 * Is this config KEY one whose value must never be logged?
 *
 * Case matters for the camelCase form and not for the snake form, for the same reason as in
 * the text scrubber: a capital (`privateKey`) or an explicit `_` (`client_secret`) is what
 * separates a real secret name from `hotkey` and `keyword`.
 */
export function isSensitiveKey(key: string): boolean {
    if (!key) {
        return false
    }
    return WHOLE_WORD_KEY_REGEX.test(key)
        || COMPOUND_CAMEL_KEY_REGEX.test(key)
        || COMPOUND_SNAKE_KEY_REGEX.test(key)
}

/**
 * Line-anchored credential scrub, applied to FUNCTION SOURCE.
 *
 * Hook bodies are real code, so a secret in one is a `const apiKey = '…'` line rather than a
 * config key — object-level key redaction cannot see it. Running the line scrubber over the
 * stringified source is what makes serialising functions safe at all.
 */
export function redactSensitiveContent(text: string): string {
    if (!text) {
        return text
    }

    const keys = [...REDACTED_KEYS].sort((a, b) => b.length - a.length).map(escapeRegex).join('|')
    const wholeWord = new RegExp(`^.*?(?<![A-Za-z0-9_$])(${keys})(?![A-Za-z0-9_$]).*$`, 'gmi')
    const compoundCamel = new RegExp(
        `^.*?(?<![A-Za-z0-9_$])([A-Za-z0-9_$]{0,64}[a-z0-9](?:${COMPOUND_SECRET_SUFFIXES_CAMEL}))\\s*[:=].*$`, 'gm')
    const compoundSnake = new RegExp(
        `^.*?(?<![A-Za-z0-9_$])([A-Za-z0-9_$]{0,64}_(?:${COMPOUND_SECRET_SUFFIXES_SNAKE}))\\s*[:=].*$`, 'gmi')

    return text.toString()
        .replace(PEM_BLOCK_REGEX, '$1[REDACTED]$2')
        .replace(PEM_UNTERMINATED_REGEX, '$1[REDACTED]')
        .replace(URL_USERINFO_REGEX, '$1[REDACTED]@')
        .replace(wholeWord, '$1: [REDACTED]')
        .replace(compoundCamel, '$1: [REDACTED]')
        .replace(compoundSnake, '$1: [REDACTED]')
}

/** Secrets that hide inside an ordinary string value, e.g. `baseUrl: 'https://u:p@host'`. */
const redactStringValue = (value: string): string => value
    .replace(PEM_BLOCK_REGEX, '$1[REDACTED]$2')
    .replace(PEM_UNTERMINATED_REGEX, '$1[REDACTED]')
    .replace(URL_USERINFO_REGEX, '$1[REDACTED]@')

/**
 * Serialize any config-shaped object for the debug log. Never throws: a serialization
 * failure returns a marker string rather than taking down the caller, which today is the
 * service constructor.
 */
export function serializeConfigForLog(value: unknown): string {
    try {
        const seen = new WeakSet<object>()

        return JSON.stringify(value, function (key, raw) {
            if (isSensitiveKey(key)) {
                return '[REDACTED]'
            }
            if (typeof raw === 'function') {
                // the whole point: `before: [null]` becomes the actual hook source
                return redactSensitiveContent(raw.toString())
            }
            if (raw instanceof RegExp) {
                return raw.toString()
            }
            if (typeof raw === 'string') {
                return redactStringValue(raw)
            }
            if (typeof raw === 'object' && raw !== null) {
                if (seen.has(raw as object)) {
                    return '[Circular]'
                }
                seen.add(raw as object)
            }
            return raw
        }) ?? 'undefined'
    } catch (error) {
        return `[unserializable: ${(error as Error)?.message || String(error)}]`
    }
}
