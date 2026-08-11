import fs from 'node:fs'
import path from 'node:path'

import type { Options } from '@wdio/types'

import { BStackLogger } from './bstackLogger.js'
import {
    BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS,
    COMPOUND_SECRET_SUFFIXES_CAMEL,
    COMPOUND_SECRET_SUFFIXES_SNAKE,
    BROWSERSTACK_WDIO_CONFIG_FILE_PATH,
    BROWSERSTACK_WDIO_CONFIG_STRATEGY,
    CAPTURE_CONFIG_IMPORT_DEPTH,
    DEFAULT_WDIO_CONFIG_BASENAME,
    MAX_CAPTURED_CONFIG_FILES,
    MAX_CAPTURED_CONFIG_FILE_BYTES,
    MAX_PACKAGE_JSON_WALK_UP,
    REDACTED_KEYS,
    SUPPORTED_WDIO_CONFIG_EXTENSIONS,
    WDIO_CLI_SUBCOMMANDS
} from './constants.js'

export interface CapturedFile {
    /* archive entry name (basename, de-duplicated) */
    name: string
    /* absolute path the content came from */
    sourcePath: string
    content: string
}

export interface ConfigPathResolution {
    configPath?: string
    /* which ladder rung answered — recorded on the SDK_UPLOAD_LOGS event */
    strategy?: string
    /* why nothing was found, when configPath is undefined */
    reason?: string
}

const isReadableFile = (filePath: string): boolean => {
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    } catch {
        return false
    }
}

/**
 * WDIO hands us the config path exactly as the user typed it (relative or absolute),
 * so every candidate is resolved against cwd — the same base the CLI itself uses
 * (`create-wdio` formatConfigFilePaths).
 */
const resolveCandidate = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.trim() === '') {
        return undefined
    }
    try {
        const resolved = path.resolve(process.cwd(), value.trim())
        return isReadableFile(resolved) ? resolved : undefined
    } catch {
        return undefined
    }
}

/** cwd-relative form of a path, for logs that get uploaded. Falls back to the input. */
const relativeToCwd = (filePath: string): string => {
    try {
        return path.relative(process.cwd(), filePath) || path.basename(filePath)
    } catch {
        return path.basename(filePath)
    }
}

const probeConfigBasename = (dir: string, basename: string): string | undefined => {
    for (const ext of SUPPORTED_WDIO_CONFIG_EXTENSIONS) {
        const candidate = path.join(dir, `${basename}${ext}`)
        if (isReadableFile(candidate)) {
            return candidate
        }
    }
    return undefined
}

/**
 * Last-resort discovery: a directory containing exactly ONE `*.conf.<ext>` file is
 * unambiguous. Two or more (e.g. `wdio.conf.ts` + `wdio.app.conf.ts`) is not, and we
 * deliberately capture nothing rather than upload the wrong file.
 */
const scanForSingleConfig = (dir: string): { match?: string, ambiguous?: boolean } => {
    try {
        const matches = fs.readdirSync(dir)
            .filter((entry) => SUPPORTED_WDIO_CONFIG_EXTENSIONS.includes(path.extname(entry)))
            .filter((entry) => /\.conf(ig)?\.[^.]+$/i.test(entry))
            .map((entry) => path.join(dir, entry))
            .filter(isReadableFile)

        if (matches.length === 1) {
            return { match: matches[0] }
        }
        return { ambiguous: matches.length > 1 }
    } catch {
        return {}
    }
}

/**
 * Scan the raw CLI args for the config positional.
 *
 * Covers `wdio <config>` (bare form), where WDIO strips the path before the config
 * object is built. A token is skipped when the PREVIOUS token is a flag, otherwise
 * `wdio run conf.js --spec ./tests/a.js` would resolve to the spec file.
 */
const scanArgvForConfig = (argv: string[]): string | undefined => {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const previous = i > 0 ? argv[i - 1] : undefined

        if (!arg || arg.startsWith('-')) {
            continue
        }
        if (WDIO_CLI_SUBCOMMANDS.includes(arg)) {
            continue
        }
        // value of a space-separated flag (`--spec ./a.js`), not a positional
        if (previous && previous.startsWith('-') && !previous.includes('=')) {
            continue
        }
        if (!SUPPORTED_WDIO_CONFIG_EXTENSIONS.includes(path.extname(arg))) {
            continue
        }

        const resolved = resolveCandidate(arg)
        if (resolved) {
            return resolved
        }
    }
    return undefined
}

/**
 * Resolve the absolute path of the user's wdio config file.
 *
 * WDIO keeps the real path in `ConfigParser`'s private `#configFilePath` field, which no
 * service can reach, so this walks a ladder of fallbacks — first rung that points at a
 * file on disk wins:
 *
 *   1. BROWSERSTACK_WDIO_CONFIG_FILE_PATH  — explicit override / support escape hatch
 *   2. config['config-path']               — yargs' kebab alias of the `run <configPath>`
 *                                            positional, which survives into the merged
 *                                            config object (v8 and v9 alike)
 *   3. process.argv positional             — `wdio <config>` without the `run` subcommand
 *   4. config._[0]                         — same positional as seen by yargs
 *   5. rootDir + wdio.conf.<ext>           — no-arg `wdio`, and programmatic `new Launcher()`
 *   6. cwd + wdio.conf.<ext>               — when the user overrides `rootDir` in their config
 *   7. single `*.conf.<ext>` in rootDir/cwd — unambiguous custom filenames only
 */
export function resolveWdioConfigPath(config?: Options.Testrunner): ConfigPathResolution {
    const configRecord = (config || {}) as Record<string, unknown>

    const fromEnv = resolveCandidate(process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH])
    if (fromEnv) {
        return { configPath: fromEnv, strategy: 'env_override' }
    }

    const fromConfigPath = resolveCandidate(configRecord['config-path'])
    if (fromConfigPath) {
        return { configPath: fromConfigPath, strategy: 'cli_config_path' }
    }

    const fromArgv = scanArgvForConfig(process.argv.slice(2))
    if (fromArgv) {
        return { configPath: fromArgv, strategy: 'argv_positional' }
    }

    const positionals = Array.isArray(configRecord._) ? configRecord._ as unknown[] : []
    for (const positional of positionals) {
        const resolved = resolveCandidate(positional)
        if (resolved && SUPPORTED_WDIO_CONFIG_EXTENSIONS.includes(path.extname(resolved))) {
            return { configPath: resolved, strategy: 'config_positional' }
        }
    }

    // `rootDir` defaults to dirname(configFile) but the user can override it in their
    // config, so it is a fallback and never the source of truth — try cwd as well.
    const rootDir = typeof configRecord.rootDir === 'string' ? configRecord.rootDir : undefined
    const searchDirs = [rootDir, process.cwd()].filter((dir): dir is string => Boolean(dir))
    const uniqueDirs = Array.from(new Set(searchDirs))

    for (const dir of uniqueDirs) {
        const probed = probeConfigBasename(dir, DEFAULT_WDIO_CONFIG_BASENAME)
        if (probed) {
            return { configPath: probed, strategy: dir === rootDir ? 'root_dir_default' : 'cwd_default' }
        }
    }

    let sawAmbiguous = false
    for (const dir of uniqueDirs) {
        const { match, ambiguous } = scanForSingleConfig(dir)
        if (match) {
            return { configPath: match, strategy: 'single_conf_scan' }
        }
        sawAmbiguous = sawAmbiguous || Boolean(ambiguous)
    }

    return { reason: sawAmbiguous ? 'config_ambiguous' : 'config_not_found' }
}

/**
 * Resolve once, as early as possible, and publish the answer on the environment so the
 * upload path (and any worker) reads the SAME value instead of re-deriving it from cwd.
 *
 * Re-resolving at archive time is precisely the bug SDK-5993 fixed in the Node SDK: the
 * archive step read `cwd/browserstack.yml` while startup had resolved a different path,
 * silently dropping the config for every monorepo / subdir CI run.
 */
export function initWdioConfigPath(config?: Options.Testrunner): ConfigPathResolution {
    try {
        const alreadyResolved = process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH]
        if (alreadyResolved) {
            // Report the rung that ORIGINALLY answered, not the env var this function
            // itself wrote — otherwise every run reports `env_override` and the metric
            // can never tell us how often the fallbacks are carrying customers.
            return {
                configPath: alreadyResolved,
                strategy: process.env[BROWSERSTACK_WDIO_CONFIG_STRATEGY] || 'env_override'
            }
        }

        const resolution = resolveWdioConfigPath(config)
        if (resolution.configPath) {
            process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH] = resolution.configPath
            if (resolution.strategy) {
                process.env[BROWSERSTACK_WDIO_CONFIG_STRATEGY] = resolution.strategy
            }
            // Relative to cwd: this log file is itself uploaded, and an absolute path leaks
            // the OS username and directory layout (`/Users/jane.doe/...`). `path.relative`
            // still yields `../../shared/wdio.conf.ts` for a config outside cwd, so the
            // monorepo/subdir diagnostic — which is the whole point of logging it — survives.
            // Path before strategy: BStackLogger scrubs any `<...>key:`/`<...>user:` prefixed
            // value, so a strategy name ending in `key`/`user` here would redact the path.
            BStackLogger.debug(`Resolved wdio config file ${relativeToCwd(resolution.configPath)} for auto-capture (strategy ${resolution.strategy})`)
        } else {
            BStackLogger.debug(`Could not resolve wdio config file for auto-capture: ${resolution.reason}`)
        }
        return resolution
    } catch (error) {
        BStackLogger.debug(`Error while resolving wdio config file: ${error}`)
        return { reason: 'config_resolve_exception' }
    }
}

/**
 * Opt-out for auto-captured logs. Service option first, env var as the CI escape hatch
 * (customers cannot always edit a committed config). Name matches the Node SDK's
 * `disableAutoCaptureLogs` so the flag means the same thing across BrowserStack SDKs.
 */
export function isAutoCaptureLogsDisabled(options?: { disableAutoCaptureLogs?: boolean }): boolean {
    if (options?.disableAutoCaptureLogs === true) {
        return true
    }
    return String(process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS] || '').toLowerCase() === 'true'
}

/**
 * Mirror the service option onto the environment so the opt-out survives into the
 * DETACHED cleanup process, which gets no options object.
 *
 * Without this the opt-out is worse than useless: skipping the upload leaves
 * `logsUploaded` false, which is exactly the condition that arms the exit-time
 * `--uploadLogs` rescue — so every opted-out run had its config read and POSTed by the
 * cleanup child. Returns whether auto-capture is disabled.
 */
export function publishAutoCaptureDisabled(options?: { disableAutoCaptureLogs?: boolean }): boolean {
    const disabled = isAutoCaptureLogsDisabled(options)
    if (disabled) {
        process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS] = 'true'
    }
    return disabled
}

/**
 * Line-level credential scrub, ported from the Node SDK's `redactSensitiveContent`.
 *
 * Any line mentioning a sensitive key collapses to `<key>: [REDACTED]`. Word boundaries
 * keep `hotkey` / `keyword` from tripping the bare `key` entry that WDIO's top-level
 * credential options force us to carry. `.` is intentionally NOT part of the boundary
 * class so `bstackOptions.accessKey = '...'` still matches.
 */
export function redactSensitiveContent(text: string): string {
    if (!text) {
        return text
    }

    const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // longest first: alternation returns the first match, not the longest one
    const keys = [...REDACTED_KEYS]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegex)
        .join('|')
    const redactRegex = new RegExp(`^.*?(?<![A-Za-z0-9_$])(${keys})(?![A-Za-z0-9_$]).*$`, 'gmi')

    // Second pass for compound identifiers ending in a sensitive word, which the
    // whole-word pass above cannot see: its lookbehind rejects the preceding letter in
    // `clientSecret` / `refreshToken` / `privateKey`, and the preceding `_` in
    // `client_secret`, so third-party secrets under those names survived it.
    //
    // Case matters here and the regex is deliberately NOT case-insensitive: requiring a
    // capitalised suffix (camelCase) or an explicit `_` (snake_case) is what separates
    // `privateKey` from `hotkey` and `client_secret` from `keyword`, so this closes the
    // leak without the false positives a bare /key|token|secret/ pass would produce.
    const compoundRegex = new RegExp(
        '^.*?(?<![A-Za-z0-9_$])' +
        `([A-Za-z0-9_$]*(?:[a-z0-9](?:${COMPOUND_SECRET_SUFFIXES_CAMEL})|_(?:${COMPOUND_SECRET_SUFFIXES_SNAKE})))` +
        '\\s*[:=].*$',
        'gm'
    )

    return text.toString()
        .replace(redactRegex, '$1: [REDACTED]')
        .replace(compoundRegex, '$1: [REDACTED]')
}

const readCappedFile = (filePath: string): { content?: string, reason?: string } => {
    try {
        const size = fs.statSync(filePath).size
        if (size > MAX_CAPTURED_CONFIG_FILE_BYTES) {
            return { reason: `${path.basename(filePath)}: too_large (${size} bytes)` }
        }
        return { content: fs.readFileSync(filePath, 'utf8') }
    } catch (error) {
        return { reason: `${path.basename(filePath)}: ${(error as Error)?.message || String(error)}` }
    }
}

/**
 * Resolve a relative import specifier against the importing file.
 *
 * Handles the TypeScript-ESM convention where `./shared.conf.js` on disk is actually
 * `./shared.conf.ts`, plus extension-less and directory (`/index.*`) specifiers.
 */
const resolveRelativeImport = (specifier: string, fromFile: string): string | undefined => {
    const base = path.resolve(path.dirname(fromFile), specifier)

    if (isReadableFile(base) && SUPPORTED_WDIO_CONFIG_EXTENSIONS.includes(path.extname(base))) {
        return base
    }

    const withoutExt = SUPPORTED_WDIO_CONFIG_EXTENSIONS.includes(path.extname(base))
        ? base.slice(0, -path.extname(base).length)
        : base

    for (const ext of SUPPORTED_WDIO_CONFIG_EXTENSIONS) {
        const candidate = `${withoutExt}${ext}`
        if (isReadableFile(candidate)) {
            return candidate
        }
    }
    for (const ext of SUPPORTED_WDIO_CONFIG_EXTENSIONS) {
        const candidate = path.join(base, `index${ext}`)
        if (isReadableFile(candidate)) {
            return candidate
        }
    }
    return undefined
}

/**
 * Collect local files a config pulls in (`wdio.shared.conf.ts` style splits), so a
 * captured config is not just a two-line file that spreads a base config we never see.
 *
 * Only RELATIVE specifiers are followed — bare specifiers are npm packages, never the
 * customer's own config. Depth and count are capped so this can never walk a source tree.
 */
const collectLocalImports = (entryPath: string, entryContent: string, budget: number): string[] => {
    const found: string[] = []
    const seen = new Set([entryPath])
    let frontier: Array<{ filePath: string, content: string }> = [{ filePath: entryPath, content: entryContent }]

    for (let depth = 0; depth < CAPTURE_CONFIG_IMPORT_DEPTH && found.length < budget; depth++) {
        const next: Array<{ filePath: string, content: string }> = []

        for (const { filePath, content } of frontier) {
            // `from './x'`, `import './x'`, `import('./x')`, `require('./x')`
            const importRegex = /(?:from|import|require)\s*\(?\s*['"](\.[^'"]*)['"]/g
            let match: RegExpExecArray | null

            while ((match = importRegex.exec(content)) !== null) {
                if (found.length >= budget) {
                    break
                }
                const resolved = resolveRelativeImport(match[1], filePath)
                if (!resolved || seen.has(resolved) || resolved.includes(`${path.sep}node_modules${path.sep}`)) {
                    continue
                }
                seen.add(resolved)

                const { content: importedContent } = readCappedFile(resolved)
                if (importedContent === undefined) {
                    continue
                }
                found.push(resolved)
                next.push({ filePath: resolved, content: importedContent })
            }
        }

        if (next.length === 0) {
            break
        }
        frontier = next
    }

    return found
}

/**
 * Give every archive entry a unique name. Two configs can share a basename
 * (`configs/wdio.conf.ts` + `shared/wdio.conf.ts`); without this the second silently
 * overwrites the first, since archive entries are keyed by basename.
 *
 * Shared with `uploadLogs`, which de-dupes the copied log files against these entries —
 * one implementation so the two can never disagree.
 */
export function dedupeEntryName(filePath: string, taken: Set<string>): string {
    const base = path.basename(filePath)
    if (!taken.has(base)) {
        taken.add(base)
        return base
    }

    const ext = path.extname(base)
    const stem = ext ? base.slice(0, -ext.length) : base
    let index = 1
    let candidate = `${stem}.${index}${ext}`
    while (taken.has(candidate)) {
        index++
        candidate = `${stem}.${index}${ext}`
    }
    taken.add(candidate)
    return candidate
}

/**
 * Build the redacted config entries added to the auto-captured log archive.
 *
 * Best effort by contract: any failure returns what was gathered so far and a reason
 * string for the SDK_UPLOAD_LOGS event. It must never throw — a debug artifact is never
 * worth failing a customer's test run over.
 */
export function collectConfigFilesForUpload(config?: Options.Testrunner): { files: CapturedFile[], failures: string[], strategy?: string } {
    const failures: string[] = []
    const files: CapturedFile[] = []
    const takenNames = new Set<string>()

    try {
        const resolution = initWdioConfigPath(config)
        if (!resolution.configPath) {
            failures.push(resolution.reason || 'config_not_found')
            return { files, failures }
        }

        const { content, reason } = readCappedFile(resolution.configPath)
        if (content === undefined) {
            failures.push(reason || 'config_read_failed')
            return { files, failures, strategy: resolution.strategy }
        }

        files.push({
            name: dedupeEntryName(resolution.configPath, takenNames),
            sourcePath: resolution.configPath,
            content: redactSensitiveContent(content)
        })

        const remaining = MAX_CAPTURED_CONFIG_FILES - files.length
        if (remaining > 0) {
            for (const importedPath of collectLocalImports(resolution.configPath, content, remaining)) {
                const imported = readCappedFile(importedPath)
                if (imported.content === undefined) {
                    if (imported.reason) {
                        failures.push(imported.reason)
                    }
                    continue
                }
                files.push({
                    name: dedupeEntryName(importedPath, takenNames),
                    sourcePath: importedPath,
                    content: redactSensitiveContent(imported.content)
                })
            }
        }

        return { files, failures, strategy: resolution.strategy }
    } catch (error) {
        failures.push(`config_capture_exception: ${(error as Error)?.message || String(error)}`)
        return { files, failures }
    }
}

/**
 * Walk up from `startDir` looking for `fileName`, stopping at the filesystem root or
 * after MAX_PACKAGE_JSON_WALK_UP levels.
 */
const findUpwards = (startDir: string, fileName: string): string | undefined => {
    let current = startDir
    for (let depth = 0; depth <= MAX_PACKAGE_JSON_WALK_UP; depth++) {
        const candidate = path.join(current, fileName)
        if (isReadableFile(candidate)) {
            return candidate
        }
        const parent = path.dirname(current)
        if (parent === current) {
            break
        }
        current = parent
    }
    return undefined
}

/**
 * `package.json` for the project the config belongs to — framework and service versions
 * are the first thing triage needs, and the archive carried neither before.
 *
 * Walks UP from the config's directory, because `configs/wdio.conf.ts` (a very common
 * layout) puts the manifest one or more levels above the config, not beside it.
 * Archived verbatim: it is a manifest, not a secret store.
 */
export function findPackageJsonForUpload(): string | undefined {
    const configPath = process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH]
    const startDirs = [configPath ? path.dirname(configPath) : undefined, process.cwd()]
        .filter((dir): dir is string => Boolean(dir))

    for (const dir of Array.from(new Set(startDirs))) {
        const found = findUpwards(dir, 'package.json')
        if (found) {
            return found
        }
    }
    return undefined
}
