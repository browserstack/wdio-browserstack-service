import fs from 'node:fs'

import { MAX_CAPTURED_CONFIG_FILE_BYTES, MAX_HOOK_SOURCE_CHARS, WDIO_HOOK_NAMES } from './constants.js'

export type HookSources = Record<string, string>

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
export function extractUserHookSources(configPath: string): HookSources {
    const sources: HookSources = {}

    let text: string
    try {
        if (fs.statSync(configPath).size > MAX_CAPTURED_CONFIG_FILE_BYTES) {
            return sources
        }
        text = fs.readFileSync(configPath, 'utf8')
    } catch {
        return sources
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
            sources[hookName] = captured.length > MAX_HOOK_SOURCE_CHARS
                ? `${captured.slice(0, MAX_HOOK_SOURCE_CHARS)}… [truncated]`
                : captured
            break
        }
    }

    return sources
}

/**
 * Hook names whose source mentions `identifier` — e.g. which hooks call `reloadSession`.
 */
export function hooksUsing(sources: HookSources, identifier: string): string[] {
    const needle = new RegExp(`(?<![A-Za-z0-9_$])${identifier}(?![A-Za-z0-9_$])`)
    return Object.entries(sources)
        .filter(([, source]) => needle.test(source))
        .map(([hookName]) => hookName)
}
