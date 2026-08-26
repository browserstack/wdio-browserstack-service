import fs from 'node:fs'

import { redactSensitiveContent } from './configCapture.js'
import { MAX_CAPTURED_CONFIG_FILE_BYTES, MAX_HOOK_SOURCE_CHARS, TRACKED_HOOK_IDENTIFIERS, WDIO_HOOK_NAMES } from './constants.js'

export type HookSources = Record<string, string>

export interface ExtractedHooks {
    /** hook name -> source, REDACTED and therefore safe to log and upload */
    sources: HookSources
    /** tracked identifier -> the hooks that call it, derived BEFORE redaction */
    identifiers: Record<string, string[]>
}

/**
 * Walk forward from an opening brace to its match, so a hook body is captured whole.
 *
 * Brace counting has to be lexical or it breaks on ordinary config code: a `'}'` inside a
 * selector string, a `//` comment mentioning a brace, or a template literal all close the body
 * early and hand back a truncated function.
 */
const sliceBalanced = (text: string, openIndex: number): string | undefined => {
    let depth = 0
    let quote: string | undefined
    let lineComment = false
    let blockComment = false

    for (let i = openIndex; i < text.length; i++) {
        const char = text[i]
        const next = text[i + 1]

        if (lineComment) {
            if (char === '\n') {
                lineComment = false
            }
            continue
        }
        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false
                i++
            }
            continue
        }
        if (quote) {
            if (char === '\\') {
                i++
            } else if (char === quote) {
                quote = undefined
            }
            continue
        }
        if (char === '/' && next === '/') {
            lineComment = true
            i++
            continue
        }
        if (char === '/' && next === '*') {
            blockComment = true
            i++
            continue
        }
        if (char === '\'' || char === '"' || char === '`') {
            quote = char
            continue
        }
        if (char === '{') {
            depth++
            continue
        }
        if (char === '}') {
            depth--
            if (depth === 0) {
                return text.slice(openIndex, i + 1)
            }
        }
    }
    return undefined
}

/**
 * Index of the brace that opens a hook's BODY, starting from its declaration.
 *
 * Not simply the next `{`: a typed parameter carries its own braces
 * (`beforeTest: function (test: { title?: string })`), and taking the first one captures the
 * type annotation instead of the body. So the parameter list is skipped by balancing its
 * parentheses first.
 */
const findBodyBrace = (text: string, fromIndex: number): number | undefined => {
    const limit = Math.min(text.length, fromIndex + 600)
    let i = fromIndex

    const openParen = text.indexOf('(', fromIndex)
    if (openParen !== -1 && openParen < limit) {
        let depth = 0
        let quote: string | undefined
        for (let j = openParen; j < text.length; j++) {
            const char = text[j]
            if (quote) {
                if (char === '\\') {
                    j++
                } else if (char === quote) {
                    quote = undefined
                }
                continue
            }
            if (char === '\'' || char === '"' || char === '`') {
                quote = char
                continue
            }
            if (char === '(') {
                depth++
            } else if (char === ')') {
                depth--
                if (depth === 0) {
                    i = j + 1
                    break
                }
            }
        }
    }

    const brace = text.indexOf('{', i)
    return brace === -1 ? undefined : brace
}

/**
 * Source text of every WDIO hook the config file declares itself.
 *
 * Read from the file rather than from the parsed config on purpose: `ConfigParser` folds every
 * hook it finds into an array as `hook.bind(service)`, and a bound function stringifies to
 * `function () { [native code] }` — so the hooks are unreadable by the time a service can see
 * them. The file is the only place the bodies survive.
 *
 * Limitation worth knowing when reading the output: only hooks written IN this file are found.
 * A config that imports its hooks from elsewhere (`...require('./hooks.conf')`) yields the
 * reference, not the body.
 */
export function extractUserHookSources(configPath: string): ExtractedHooks {
    const sources: HookSources = {}
    const identifiers: Record<string, string[]> = {}
    const empty = { sources, identifiers }

    let text: string
    try {
        if (fs.statSync(configPath).size > MAX_CAPTURED_CONFIG_FILE_BYTES) {
            return empty
        }
        text = fs.readFileSync(configPath, 'utf8')
    } catch {
        return empty
    }

    for (const hookName of WDIO_HOOK_NAMES) {
        // `before:` as a property, or `before (` / `async before (` as a method shorthand.
        // The negative lookbehind keeps `beforeTest` from matching a search for `before`.
        const declaration = new RegExp(`(?<![A-Za-z0-9_$])${hookName}\\s*(?::|\\()`, 'g')
        let match: RegExpExecArray | null

        while ((match = declaration.exec(text)) !== null) {
            const openIndex = findBodyBrace(text, match.index)
            if (openIndex === undefined) {
                continue
            }
            // Anything between the declaration and the first brace should be a function head
            // (`function`, `async`, arrow, parameters). A newline-separated object property whose
            // value is on another line is not this hook's body.
            const head = text.slice(match.index, openIndex)
            // Everything between the hook name and its body must look like a function head:
            // `: async function (args)`, `(args)`, `: (args) =>`. A `;` or a stray `=` means we
            // matched a mention of the name rather than its declaration.
            if (!/^[A-Za-z0-9_$]+\s*:?\s*(?:async\s+)?(?:function\s*)?[A-Za-z0-9_$]*\s*(?:\([^;]*\))?\s*(?::[^;{]*)?\s*(?:=>)?\s*$/.test(head)) {
                continue
            }
            const body = sliceBalanced(text, openIndex)
            if (!body) {
                continue
            }
            const captured = `${head.trim()}${body}`

            // Identifier scan runs on the RAW body, before redaction. redactSensitiveContent
            // replaces a whole matching LINE, so `await browser.reloadSession({ userName, accessKey })`
            // — reloading with fresh credentials, a real pattern — collapses to `[REDACTED]` and the
            // call disappears. Scanning first keeps the detection while the stored copy stays safe.
            for (const identifier of TRACKED_HOOK_IDENTIFIERS) {
                if (mentions(captured, identifier)) {
                    identifiers[identifier] = [...(identifiers[identifier] || []), hookName]
                }
            }

            // Hook bodies are customer code and this log is uploaded, so the stored copy is
            // redacted with the same routine that guards an uploaded config file. The logger's own
            // scrub is narrower — it misses authToken, password, clientSecret, URL userinfo and PEM
            // blocks — so relying on it would publish those in the clear.
            const safe = redactSensitiveContent(captured)
            sources[hookName] = safe.length > MAX_HOOK_SOURCE_CHARS
                ? `${safe.slice(0, MAX_HOOK_SOURCE_CHARS)}… [truncated]`
                : safe
            break
        }
    }

    return { sources, identifiers }
}

const mentions = (source: string, identifier: string): boolean =>
    new RegExp(`(?<![A-Za-z0-9_$])${identifier}(?![A-Za-z0-9_$])`).test(source)

/**
 * Hook names whose source mentions `identifier` — e.g. which hooks call `reloadSession`.
 *
 * Note this reads whatever it is given: on the REDACTED sources it can miss a call that shared a
 * line with a credential. `extractUserHookSources` reports `identifiers` from the raw text for
 * exactly that reason; prefer it.
 */
export function hooksUsing(sources: HookSources, identifier: string): string[] {
    return Object.entries(sources)
        .filter(([, source]) => mentions(source, identifier))
        .map(([hookName]) => hookName)
}
