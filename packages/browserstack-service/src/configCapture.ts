import fs from 'node:fs'
import path from 'node:path'

import type { Options } from '@wdio/types'

import { BStackLogger } from './bstackLogger.js'
import {
    BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS,
    COMPOUND_SECRET_SUFFIXES_CAMEL,
    COMPOUND_SECRET_SUFFIXES_SNAKE,
    PEM_BLOCK_REGEX,
    PEM_UNTERMINATED_REGEX,
    URL_USERINFO_REGEX,
    BROWSERSTACK_WDIO_CONFIG_FILE_PATH,
    BROWSERSTACK_WDIO_CONFIG_STRATEGY,
    CAPTURE_CONFIG_IMPORT_DEPTH,
    DEFAULT_WDIO_CONFIG_BASENAME,
    MAX_ALIAS_MANIFEST_EXTENDS_DEPTH,
    MAX_CAPTURED_CONFIG_FILES,
    MAX_CAPTURED_CONFIG_FILE_BYTES,
    MAX_PACKAGE_JSON_WALK_UP,
    PATH_ALIAS_MANIFESTS,
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
 * Accept a config path the way `@wdio/cli` does: the value as spelled, else the same stem
 * probed across the supported extensions.
 *
 * The probe is not defensive padding — it is required. `commands/run.ts` hands `Launcher` the
 * path that `canAccessConfigPath` found, but leaves `config-path` set to what the USER typed,
 * and a TypeScript project legally spells a `.ts` config with `.js`. Verified against a real
 * wdio run: `wdio run ./configs/a.conf.js` with only `configs/a.conf.ts` on disk starts fine
 * and reports `config-path: './configs/a.conf.js'`, a path that does not exist.
 */
const resolveCandidate = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value.trim()) {
        return undefined
    }
    try {
        const full = path.resolve(process.cwd(), value.trim())
        const ext = path.extname(full)
        const stem = SUPPORTED_WDIO_CONFIG_EXTENSIONS.includes(ext) ? full.slice(0, -ext.length) : full
        return [full, ...SUPPORTED_WDIO_CONFIG_EXTENSIONS.map((e) => `${stem}${e}`)]
            .find(isReadableFile)
    } catch {
        return undefined
    }
}

/**
 * cwd-relative form of a FILE path, for anything that gets uploaded.
 *
 * The basename fallback is safe here only because `path.relative` is never empty for a file —
 * a file is never equal to cwd. Do NOT pass a directory: see `relativeDirToCwd`.
 */
export const relativeToCwd = (filePath: string): string => {
    try {
        return path.relative(process.cwd(), filePath) || path.basename(filePath)
    } catch {
        return path.basename(filePath)
    }
}

/**
 * cwd-relative form of a DIRECTORY path.
 *
 * `path.relative(cwd, cwd)` is `''`, which is the COMMON case here (a manifest at the project
 * root), so a basename fallback would report the folder name — and for a project checked out
 * directly in `$HOME` that folder name is the OS username, which is the exact exposure the
 * relative-path handling exists to prevent. Empty means "cwd", so render it as `.`.
 */
export const relativeDirToCwd = (dir: string): string => {
    try {
        return path.relative(process.cwd(), dir) || '.'
    } catch {
        return '.'
    }
}

/**
 * Resolve the absolute path of the user's wdio config file.
 *
 * WDIO keeps the real path in `ConfigParser`'s private `#configFilePath`, which no service can
 * reach, so this reconstructs it from the values the CLI does leave on the merged config —
 * mirroring how `@wdio/cli` itself resolves it. The CLI never searches: it takes one candidate
 * and probes one stem across the supported extensions, so neither does this.
 *
 *   1. BROWSERSTACK_WDIO_CONFIG_FILE_PATH  — explicit override / support escape hatch
 *   2. config['config-path']               — yargs' kebab alias of the `run <configPath>`
 *                                            positional (v8 and v9 alike)
 *   3. config._[0]                         — the bare `wdio <config>` form, which `run.ts`
 *                                            itself resolves from `params._[0]`
 *   4. rootDir + wdio.conf.<ext>           — no-arg `wdio`, and programmatic `new Launcher()`
 *   5. cwd + wdio.conf.<ext>               — when the user overrides `rootDir` in their config
 *
 * `config._` is read rather than raw `process.argv`: it is the same positional AFTER yargs has
 * applied wdio's own option declarations. Scanning argv means re-implementing that with a
 * heuristic that cannot know which flags are boolean — and `wdio --watch ./a.conf.ts` puts the
 * real config in `_[0]` while any "skip a flag's value" rule throws it away.
 */
export function resolveWdioConfigPath(config?: Options.Testrunner): ConfigPathResolution {
    const record = (config || {}) as Record<string, unknown>

    try {
        const positionals = Array.isArray(record._) ? record._ as unknown[] : []
        const positional = positionals.filter(
            (entry): entry is string => typeof entry === 'string' && !WDIO_CLI_SUBCOMMANDS.includes(entry)
        )[0]
        const rootDir = typeof record.rootDir === 'string' ? record.rootDir : undefined

        const rungs: Array<[string, unknown]> = [
            ['env_override', process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH]],
            ['cli_config_path', record['config-path']],
            ['config_positional', positional],
            ['root_dir_default', rootDir && path.join(rootDir, DEFAULT_WDIO_CONFIG_BASENAME)],
            ['cwd_default', DEFAULT_WDIO_CONFIG_BASENAME]
        ]

        for (const [strategy, value] of rungs) {
            const configPath = resolveCandidate(value)
            if (configPath) {
                return { configPath, strategy }
            }
        }

        return { reason: 'config_not_found' }
    } catch {
        return { reason: 'config_resolve_exception' }
    }
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

    // Compound identifiers ending in a sensitive word, which the whole-word pass above
    // cannot see: its lookbehind rejects the preceding letter in `clientSecret` /
    // `refreshToken` / `privateKey`, and the preceding `_` in `client_secret`.
    //
    // camelCase stays case-SENSITIVE: requiring a capitalised suffix is what separates
    // `privateKey` from `hotkey`, so this closes the leak without the false positives a
    // bare /key|token|secret/ pass would produce. The core does NOT require a lowercase
    // char before the suffix — that guard only ever duplicated the case-sensitivity, while
    // rejecting acronym prefixes (`APIToken`, `JWTSecret`, `SSHKey`, `AWSSecret`).
    // Identifier scans are bounded at 64 chars. Real config keys are far shorter, so this
    // changes no match; it is defence-in-depth against backtracking on a pathological line
    // (a minified/base64 run), keeping every start position O(1) instead of O(n).
    const compoundCamelRegex = new RegExp(
        `^.*?(?<![A-Za-z0-9_$])([A-Za-z0-9_$]{1,64}(?:${COMPOUND_SECRET_SUFFIXES_CAMEL}))\\s*[:=].*$`,
        'gm'
    )
    // snake_case is matched case-INSENSITIVELY, which is safe precisely because it requires
    // an explicit `_` before the suffix. That covers SCREAMING_SNAKE_CASE — the dominant
    // convention for secrets in config/env files (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`) —
    // while `keyword` and `my_secretary` still fall out, since neither has `_<suffix>`
    // immediately before an assignment.
    const compoundSnakeRegex = new RegExp(
        `^.*?(?<![A-Za-z0-9_$])([A-Za-z0-9_$]{0,64}_(?:${COMPOUND_SECRET_SUFFIXES_SNAKE}))\\s*[:=].*$`,
        'gmi'
    )

    return text.toString()
        // Block-level passes run FIRST: they span lines, and the line-anchored passes below
        // can only ever see the one line that carries the key name.
        .replace(PEM_BLOCK_REGEX, '$1[REDACTED]$2')
        .replace(PEM_UNTERMINATED_REGEX, '$1[REDACTED]')
        .replace(URL_USERINFO_REGEX, '$1[REDACTED]@')
        .replace(redactRegex, '$1: [REDACTED]')
        .replace(compoundCamelRegex, '$1: [REDACTED]')
        .replace(compoundSnakeRegex, '$1: [REDACTED]')
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
/**
 * Only files that are themselves configs are followed.
 *
 * A relative specifier resolves to whatever the config happens to import, which is frequently
 * ordinary application source (`./helpers/utils.js`) rather than configuration. Capturing the
 * split-config case (`base.conf.js`, `wdio.shared.conf.ts`) is the point; shipping a
 * customer's application modules is not.
 */
const isConfigFileName = (filePath: string): boolean => /\.conf(ig)?\.[^.]+$/i.test(path.basename(filePath))

const probeConfigCandidate = (base: string): string | undefined => {
    if (isReadableFile(base) && SUPPORTED_WDIO_CONFIG_EXTENSIONS.includes(path.extname(base))) {
        return isConfigFileName(base) ? base : undefined
    }

    const withoutExt = SUPPORTED_WDIO_CONFIG_EXTENSIONS.includes(path.extname(base))
        ? base.slice(0, -path.extname(base).length)
        : base

    for (const ext of SUPPORTED_WDIO_CONFIG_EXTENSIONS) {
        const candidate = `${withoutExt}${ext}`
        if (isReadableFile(candidate) && isConfigFileName(candidate)) {
            return candidate
        }
    }
    for (const ext of SUPPORTED_WDIO_CONFIG_EXTENSIONS) {
        const candidate = path.join(base, `index${ext}`)
        if (isReadableFile(candidate) && isConfigFileName(candidate)) {
            return candidate
        }
    }
    return undefined
}

const resolveRelativeImport = (specifier: string, fromFile: string): string | undefined =>
    probeConfigCandidate(path.resolve(path.dirname(fromFile), specifier))

/**
 * Strip comments and trailing commas so a tsconfig can be JSON.parse'd.
 *
 * tsconfig is JSONC and real ones are full of comments, so a plain JSON.parse fails on the
 * majority of them. String literals are tracked because a Windows path (`"C:\\a"`) and a URL
 * in a comment both contain sequences that a naive strip would treat as delimiters.
 */
const parseJsonc = (text: string): Record<string, unknown> | undefined => {
    let out = ''
    let inString = false
    let inLine = false
    let inBlock = false

    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        const next = text[i + 1]

        if (inLine) {
            if (char === '\n') {
                inLine = false
                out += char
            }
            continue
        }
        if (inBlock) {
            if (char === '*' && next === '/') {
                inBlock = false
                i++
            }
            continue
        }
        if (inString) {
            out += char
            if (char === '\\') {
                out += next ?? ''
                i++
            } else if (char === '"') {
                inString = false
            }
            continue
        }
        if (char === '"') {
            inString = true
            out += char
            continue
        }
        if (char === '/' && next === '/') {
            inLine = true
            i++
            continue
        }
        if (char === '/' && next === '*') {
            inBlock = true
            i++
            continue
        }
        out += char
    }

    try {
        return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>
    } catch {
        return undefined
    }
}

interface AliasPattern {
    /* text before the single `*`, or the whole pattern for an exact alias */
    prefix: string
    /* text after the `*`; empty for a prefix-only or exact alias */
    suffix: string
    /* absolute target paths, `*` still in place */
    targets: string[]
    /* exact aliases must match the specifier in full */
    exact: boolean
}

/**
 * `compilerOptions.paths` from the nearest tsconfig/jsconfig, following `extends`.
 *
 * Split configs are routinely wired with aliases rather than relative paths — the customer
 * whose bundle prompted this imports every one of its configs as `@wdioConfs/...` — and an
 * alias-only project used to hand us a single entry config that spreads files we never see.
 */
const collectAliasPatterns = (manifestPath: string, depth = 0): AliasPattern[] => {
    const parsed = parseJsonc(readCappedFile(manifestPath).content || '')
    if (!parsed) {
        return []
    }

    const manifestDir = path.dirname(manifestPath)
    const compilerOptions = (parsed.compilerOptions || {}) as Record<string, unknown>
    const paths = (compilerOptions.paths || {}) as Record<string, unknown>
    // No baseUrl is legal since TS 4.4, and then targets resolve against the tsconfig itself.
    const baseUrl = typeof compilerOptions.baseUrl === 'string'
        ? path.resolve(manifestDir, compilerOptions.baseUrl)
        : manifestDir

    const patterns: AliasPattern[] = []
    for (const [pattern, rawTargets] of Object.entries(paths)) {
        const targets = (Array.isArray(rawTargets) ? rawTargets : [])
            .filter((target): target is string => typeof target === 'string')
            .map((target) => path.resolve(baseUrl, target))
        if (targets.length === 0) {
            continue
        }
        const star = pattern.indexOf('*')
        patterns.push(star === -1
            ? { prefix: pattern, suffix: '', targets, exact: true }
            : { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), targets, exact: false })
    }

    // `extends` is resolved relative to the extending file; a bare specifier is a shared
    // config package, which is worth one node_modules probe and no more.
    const extendsList = Array.isArray(parsed.extends)
        ? parsed.extends.filter((entry): entry is string => typeof entry === 'string')
        : (typeof parsed.extends === 'string' ? [parsed.extends] : [])

    if (depth < MAX_ALIAS_MANIFEST_EXTENDS_DEPTH) {
        for (const entry of extendsList) {
            const candidates = entry.startsWith('.')
                ? [path.resolve(manifestDir, entry), path.resolve(manifestDir, `${entry}.json`)]
                : [path.join(manifestDir, 'node_modules', entry), path.join(manifestDir, 'node_modules', entry, 'tsconfig.json')]
            const parent = candidates.find(isReadableFile)
            if (parent) {
                // Own patterns win: the extending file overrides its base.
                patterns.push(...collectAliasPatterns(parent, depth + 1))
            }
        }
    }

    return patterns
}

const findAliasPatterns = (entryPath: string): AliasPattern[] => {
    for (const manifest of PATH_ALIAS_MANIFESTS) {
        const found = findUpwards(path.dirname(entryPath), manifest)
        if (found) {
            const patterns = collectAliasPatterns(found)
            if (patterns.length > 0) {
                return patterns
            }
        }
    }
    return []
}

const resolveAliasImport = (specifier: string, patterns: AliasPattern[]): string | undefined => {
    for (const { prefix, suffix, targets, exact } of patterns) {
        let wildcard: string | undefined
        if (exact) {
            if (specifier !== prefix) {
                continue
            }
            wildcard = ''
        } else {
            if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) ||
                specifier.length < prefix.length + suffix.length) {
                continue
            }
            wildcard = specifier.slice(prefix.length, specifier.length - (suffix.length || 0))
        }

        for (const target of targets) {
            const resolved = probeConfigCandidate(target.replace('*', wildcard))
            if (resolved) {
                return resolved
            }
        }
    }
    return undefined
}

/**
 * Collect local files a config pulls in (`wdio.shared.conf.ts` style splits), so a
 * captured config is not just a two-line file that spreads a base config we never see.
 *
 * Two kinds of specifier are followed: RELATIVE ones, and bare ones that a tsconfig
 * `paths` alias maps back into the project. Anything else is an npm package. Every
 * candidate still has to be named like a config (`*.conf.*` / `*.config.*`), so an
 * alias table pointing at `src/*` cannot turn this into a source-tree crawl, and depth
 * and count stay capped.
 */
const collectLocalImports = (entryPath: string, entryContent: string, budget: number): Array<{ filePath: string, content: string }> => {
    const found: Array<{ filePath: string, content: string }> = []
    const seen = new Set([entryPath])
    let frontier: Array<{ filePath: string, content: string }> = [{ filePath: entryPath, content: entryContent }]
    // Resolved lazily: only an unresolved bare specifier needs the alias table, so a
    // project that splits its config relatively never reads a tsconfig at all.
    let aliasPatterns: AliasPattern[] | undefined

    for (let depth = 0; depth < CAPTURE_CONFIG_IMPORT_DEPTH && found.length < budget; depth++) {
        const next: Array<{ filePath: string, content: string }> = []

        for (const { filePath, content } of frontier) {
            // `from 'x'`, `import 'x'`, `import('x')`, `require('x')`
            const importRegex = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g
            let match: RegExpExecArray | null

            while ((match = importRegex.exec(content)) !== null) {
                if (found.length >= budget) {
                    break
                }
                const specifier = match[1]
                let resolved: string | undefined
                if (specifier.startsWith('.')) {
                    resolved = resolveRelativeImport(specifier, filePath)
                } else {
                    if (aliasPatterns === undefined) {
                        aliasPatterns = findAliasPatterns(entryPath)
                    }
                    resolved = aliasPatterns.length > 0 ? resolveAliasImport(specifier, aliasPatterns) : undefined
                }
                if (!resolved || seen.has(resolved) || resolved.includes(`${path.sep}node_modules${path.sep}`)) {
                    continue
                }
                seen.add(resolved)

                const { content: importedContent } = readCappedFile(resolved)
                if (importedContent === undefined) {
                    continue
                }
                found.push({ filePath: resolved, content: importedContent })
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
            // content comes back from the discovery pass — re-reading here would be a second
            // disk read per file and could archive different bytes than were scanned.
            for (const imported of collectLocalImports(resolution.configPath, content, remaining)) {
                files.push({
                    name: dedupeEntryName(imported.filePath, takenNames),
                    sourcePath: imported.filePath,
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
