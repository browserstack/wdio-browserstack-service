import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

import {
    collectConfigFilesForUpload,
    findPackageJsonForUpload,
    initWdioConfigPath,
    isAutoCaptureLogsDisabled,
    redactSensitiveContent,
    resolveWdioConfigPath
} from '../src/configCapture.js'
import {
    BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS,
    BROWSERSTACK_WDIO_CONFIG_FILE_PATH,
    BROWSERSTACK_WDIO_CONFIG_STRATEGY
} from '../src/constants.js'

const CONFIG_SRC = `
import { shared } from './shared.conf.js'

export const config = {
    ...shared,
    user: 'my-real-username',
    key: 'my-real-access-key',
    hostname: 'hub.browserstack.com',
    capabilities: [{
        'bstack:options': { userName: 'someone', accessKey: 'sk_live_abcdef' }
    }],
    services: [['browserstack', { accessibility: true }]]
}
`

let tmpRoot: string
let cwdSpy: ReturnType<typeof vi.spyOn>
const originalArgv = process.argv

const useCwd = (dir: string) => {
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
}

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-cfg-test-'))
    delete process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH]
    delete process.env[BROWSERSTACK_WDIO_CONFIG_STRATEGY]
    delete process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS]
    process.argv = ['node', 'wdio']
    useCwd(tmpRoot)
})

afterEach(() => {
    cwdSpy?.mockRestore()
    process.argv = originalArgv
    delete process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH]
    delete process.env[BROWSERSTACK_WDIO_CONFIG_STRATEGY]
    delete process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS]
    fs.rmSync(tmpRoot, { recursive: true, force: true })
})

const write = (relativePath: string, content = 'export const config = {}') => {
    const absolute = path.join(tmpRoot, relativePath)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
    return absolute
}

describe('resolveWdioConfigPath', () => {
    it('prefers the BROWSERSTACK_WDIO_CONFIG_FILE_PATH override', () => {
        const override = write('somewhere/custom.conf.ts')
        write('wdio.conf.js')
        process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH] = override

        expect(resolveWdioConfigPath({} as never)).toEqual({ configPath: override, strategy: 'env_override' })
    })

    it('resolves a relative `config-path` against cwd (wdio run ./x.conf.ts)', () => {
        const expected = write('configs/wdio.bstack.conf.ts')

        expect(resolveWdioConfigPath({ 'config-path': './configs/wdio.bstack.conf.ts' } as never))
            .toEqual({ configPath: expected, strategy: 'cli_config_path' })
    })

    it('resolves an absolute `config-path`', () => {
        const expected = write('wdio.conf.ts')

        expect(resolveWdioConfigPath({ 'config-path': expected } as never))
            .toEqual({ configPath: expected, strategy: 'cli_config_path' })
    })

    it('ignores a `config-path` that no longer exists and falls through', () => {
        const expected = write('wdio.conf.js')

        expect(resolveWdioConfigPath({ 'config-path': './deleted.conf.ts' } as never))
            .toEqual({ configPath: expected, strategy: 'cwd_default' })
    })

    it('resolves the bare `wdio <config>` form from config._', () => {
        const expected = write('custom.conf.mjs')

        expect(resolveWdioConfigPath({ _: ['./custom.conf.mjs'] } as never))
            .toEqual({ configPath: expected, strategy: 'config_positional' })
    })

    it('resolves `wdio --watch <config>`, where the config lands in _ after a boolean flag', () => {
        // yargs consumes nothing for a boolean flag, so `_[0]` IS the config. A raw-argv scan
        // that skips "a flag's value" throws this away; reading config._ cannot.
        const expected = write('configs/a.conf.ts')

        expect(resolveWdioConfigPath({ _: ['./configs/a.conf.ts'], watch: true } as never))
            .toEqual({ configPath: expected, strategy: 'config_positional' })
    })

    it('probes the stem when the CLI value carries a .js spelling for a .ts file', () => {
        // Real wdio behaviour: `wdio run ./configs/a.conf.js` starts fine with only
        // configs/a.conf.ts on disk, and leaves the non-existent spelling on config-path.
        const expected = write('configs/a.conf.ts')

        expect(resolveWdioConfigPath({ 'config-path': './configs/a.conf.js' } as never))
            .toEqual({ configPath: expected, strategy: 'cli_config_path' })
    })

    it('cannot be fooled by a --spec value, because yargs never leaves it in _', () => {
        // Measured with wdio's own declaration (spec: {type:'array'}): `wdio --spec ./a.js`
        // leaves _ EMPTY, so there is no positional to mistake, and resolution falls through
        // to the default config. This is why reading config._ needs no flag-value heuristic.
        const expected = write('wdio.conf.js')
        write('a.js')

        expect(resolveWdioConfigPath({ _: [], spec: ['./a.js'] } as never))
            .toEqual({ configPath: expected, strategy: 'cwd_default' })
    })

    it('ignores the `run` subcommand when reading positionals', () => {
        write('run')
        const expected = write('wdio.conf.cts')

        expect(resolveWdioConfigPath({ _: ['run', './wdio.conf.cts'] } as never).configPath)
            .toBe(expected)
    })

    it('probes rootDir for wdio.conf with every supported extension', () => {
        const nested = path.join(tmpRoot, 'nested')
        fs.mkdirSync(nested)
        const expected = write('nested/wdio.conf.mts')

        expect(resolveWdioConfigPath({ rootDir: nested } as never))
            .toEqual({ configPath: expected, strategy: 'root_dir_default' })
    })

    it('falls back to cwd when the user overrides rootDir', () => {
        const expected = write('wdio.conf.js')

        expect(resolveWdioConfigPath({ rootDir: '/definitely/not/here' } as never))
            .toEqual({ configPath: expected, strategy: 'cwd_default' })
    })

    it('does not guess when a custom-named config exists and the CLI gave nothing', () => {
        // The directory-scan rung is gone: wdio itself never searches, so neither do we.
        // Stem-probing the CLI value covers what that rung used to rescue, deterministically.
        write('e2e.conf.ts')

        expect(resolveWdioConfigPath({} as never)).toEqual({ reason: 'config_not_found' })
    })

    it('reports config_not_found on an empty project', () => {
        expect(resolveWdioConfigPath({} as never)).toEqual({ reason: 'config_not_found' })
    })
})

describe('initWdioConfigPath', () => {
    it('publishes the resolved path on the environment', () => {
        const expected = write('wdio.conf.js')

        initWdioConfigPath({} as never)

        expect(process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH]).toBe(expected)
    })

    it('reports the original rung on later calls, not env_override', () => {
        write('configs/wdio.custom.conf.ts')

        const first = initWdioConfigPath({ 'config-path': './configs/wdio.custom.conf.ts' } as never)
        const second = initWdioConfigPath({} as never)

        expect(first.strategy).toBe('cli_config_path')
        expect(second.strategy).toBe('cli_config_path')
        expect(second.configPath).toBe(first.configPath)
    })

    it('reports env_override when the user set the env var themselves', () => {
        process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH] = write('wdio.conf.js')

        expect(initWdioConfigPath({} as never).strategy).toBe('env_override')
    })

    it('leaves the env untouched when nothing resolves', () => {
        initWdioConfigPath({} as never)

        expect(process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH]).toBeUndefined()
    })
})

describe('redactSensitiveContent', () => {
    it('scrubs wdio top-level credentials and bstack:options credentials', () => {
        const redacted = redactSensitiveContent(CONFIG_SRC)

        expect(redacted).not.toContain('my-real-username')
        expect(redacted).not.toContain('my-real-access-key')
        expect(redacted).not.toContain('sk_live_abcdef')
        expect(redacted).not.toContain('someone')
    })

    it('keeps non-credential config intact', () => {
        const redacted = redactSensitiveContent(CONFIG_SRC)

        expect(redacted).toContain('accessibility: true')
        expect(redacted).toContain('hub.browserstack.com')
    })

    it('does not over-redact identifiers that merely contain key/user', () => {
        const redacted = redactSensitiveContent([
            'const hotkey = "ctrl+a"',
            'const keyword = "search"',
            'const username_suffix_thing = 1',
            'monkeypatch()'
        ].join('\n'))

        expect(redacted).toContain('ctrl+a')
        expect(redacted).toContain('search')
        expect(redacted).toContain('monkeypatch()')
    })

    it('scrubs dotted property assignment (bstackOptions.accessKey = ...)', () => {
        expect(redactSensitiveContent('bstackOptions.accessKey = "leaked-key"'))
            .not.toContain('leaked-key')
    })

    it('scrubs compound camelCase secret keys (PR review, SDK-7250)', () => {
        // The whole-word pass cannot see these: its lookbehind rejects the letter before
        // `Secret`/`Token`/`Key`, so third-party secrets under compound names survived it.
        const redacted = redactSensitiveContent([
            "clientSecret: 'cs_live_leak'",
            "refreshToken: 'ya29_leak'",
            "privateKey: '-----BEGIN PRIVATE KEY-----'",
            "sessionSecret: 'sess_leak'",
            'bearerToken = "bt_leak"'
        ].join('\n'))

        expect(redacted).not.toContain('cs_live_leak')
        expect(redacted).not.toContain('ya29_leak')
        expect(redacted).not.toContain('BEGIN PRIVATE KEY')
        expect(redacted).not.toContain('sess_leak')
        expect(redacted).not.toContain('bt_leak')
    })

    it('scrubs snake_case secret keys', () => {
        const redacted = redactSensitiveContent([
            "client_secret: 'snake_leak'",
            "refresh_token: 'snake_token_leak'",
            "private_key: 'snake_key_leak'"
        ].join('\n'))

        expect(redacted).not.toContain('snake_leak')
        expect(redacted).not.toContain('snake_token_leak')
        expect(redacted).not.toContain('snake_key_leak')
    })

    it('still does not over-redact lookalike identifiers', () => {
        // Case sensitivity is what buys this: a bare /key|token|secret/ pass would take
        // all of these with it.
        const redacted = redactSensitiveContent([
            "hotkey: 'ctrl+a'",
            "keyword: 'search'",
            "monkeypatch: 'enabled'",
            "tokenizer: 'default'",
            "secretary: 'name'"
        ].join('\n'))

        expect(redacted).toContain('ctrl+a')
        expect(redacted).toContain('search')
        expect(redacted).toContain('enabled')
        expect(redacted).toContain('default')
        expect(redacted).toContain('name')
    })

    it('scrubs SCREAMING_SNAKE_CASE secret keys (PR review round 2)', () => {
        // The dominant convention for secrets in config/env files. The snake branch is
        // matched case-insensitively, which is safe because it requires an explicit `_`.
        const redacted = redactSensitiveContent([
            "CLIENT_SECRET: 'screaming_leak'",
            "AWS_SECRET_ACCESS_KEY: 'AKIA_leak'",
            "GITHUB_TOKEN = 'ghp_screaming_leak'",
            "REFRESH_TOKEN: 'rt_screaming_leak'",
            "export const DB_PASSWORD = 'pw_screaming_leak'"
        ].join('\n'))

        expect(redacted).not.toContain('screaming_leak')
        expect(redacted).not.toContain('AKIA_leak')
        expect(redacted).not.toContain('ghp_screaming_leak')
        expect(redacted).not.toContain('rt_screaming_leak')
        expect(redacted).not.toContain('pw_screaming_leak')
    })

    it('does not over-redact uppercase lookalikes', () => {
        const redacted = redactSensitiveContent([
            "HOTKEY: 'ctrl+a'",
            "KEYWORD: 'search'",
            "my_secretary: 'jane'"
        ].join('\n'))

        expect(redacted).toContain('ctrl+a')
        expect(redacted).toContain('search')
        expect(redacted).toContain('jane')
    })

    it('scrubs a multi-line PEM block, not just the line naming it', () => {
        const redacted = redactSensitiveContent([
            'credentials: {',
            '    privateKey: `-----BEGIN PRIVATE KEY-----',
            'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCsecretbytes',
            '-----END PRIVATE KEY-----`',
            '}'
        ].join('\n'))

        expect(redacted).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCsecretbytes')
    })

    it('scrubs basic-auth credentials embedded in any URL, not just proxyUrl', () => {
        const redacted = redactSensitiveContent([
            "baseUrl: 'https://admin:s3cr3tPass@example.com'",
            "mongoUri: 'mongodb://dbuser:dbP4ss@cluster0.example.net'"
        ].join('\n'))

        expect(redacted).not.toContain('s3cr3tPass')
        expect(redacted).not.toContain('dbP4ss')
        expect(redacted).toContain('example.com')
    })

    it('leaves a port-bearing URL with no userinfo alone', () => {
        expect(redactSensitiveContent("baseUrl: 'https://example.com:8080/path'"))
            .toContain('https://example.com:8080/path')
    })

    it('scrubs single-token userinfo in a URL, not just user:pass (PR review round 3)', () => {
        // Common in CI git remotes and npm registry auth.
        const redacted = redactSensitiveContent([
            "repoUrl: 'https://ghp_TOKENLEAK@github.com/x/y.git'",
            "registry: 'https://npm_TOKENLEAK2@registry.example.com'"
        ].join('\n'))

        expect(redacted).not.toContain('ghp_TOKENLEAK')
        expect(redacted).not.toContain('npm_TOKENLEAK2')
        expect(redacted).toContain('github.com')
    })

    it('scrubs an unterminated PEM block without eating the rest of the file', () => {
        const redacted = redactSensitiveContent([
            'credentials: {',
            '    privateKey: `-----BEGIN PRIVATE KEY-----',
            'MIIEvQIBADANunterminatedbytes',
            'nextOption: 1',
            '}'
        ].join('\n'))

        expect(redacted).not.toContain('MIIEvQIBADANunterminatedbytes')
        // a malformed block must not swallow everything after it
        expect(redacted).toContain('nextOption')
    })

    it('does not let an unterminated PEM swallow a later, unrelated PEM block', () => {
        // Found live: with an untempered body the FIRST (unterminated) BEGIN matched through
        // to the SECOND block's END marker, replacing every unrelated line in between.
        const redacted = redactSensitiveContent([
            'openPem: `-----BEGIN RSA PRIVATE KEY-----',
            'MIIEUNTERMINATEDBYTESMUSTNOTAPPEAR`,',
            "afterPem: 'STILL_READABLE_MARKER',",
            'pem: `-----BEGIN PRIVATE KEY-----',
            'MIIEvQTERMINATEDBYTESMUSTNOTAPPEAR',
            '-----END PRIVATE KEY-----`,'
        ].join('\n'))

        expect(redacted).not.toContain('MIIEUNTERMINATEDBYTESMUSTNOTAPPEAR')
        expect(redacted).not.toContain('MIIEvQTERMINATEDBYTESMUSTNOTAPPEAR')
        // the line between the two blocks must survive
        expect(redacted).toContain('STILL_READABLE_MARKER')
    })

    it('stays linear on pathological input (ReDoS guard)', () => {
        // The unbounded URL userinfo pass was measurably quadratic: 100 KB of word
        // characters took ~6.1s, 4x per doubling, and redactSensitiveContent runs
        // synchronously inside uploadLogs. Bounded quantifiers keep it flat.
        const build = (n: number) => `baseUrl: 'https://${'a'.repeat(n)}` + '\n' + `k${'b'.repeat(n)}Key`

        const started = Date.now()
        redactSensitiveContent(build(200_000))
        const elapsed = Date.now() - started

        // generous ceiling: the unbounded form did not finish 1 MB in 120s
        expect(elapsed).toBeLessThan(2_000)
    })

    it('scrubs acronym-prefixed camelCase secret keys (PR review round 4)', () => {
        // The old core required a lowercase char before the suffix, so an uppercase acronym
        // prefix slipped past BOTH passes: the camel core rejected `APIToken` on the `I`, and
        // the whole-word pass rejected `Token` for the same preceding `I`.
        const redacted = redactSensitiveContent([
            "APIToken: 'API_LEAK'",
            "JWTSecret: 'JWT_LEAK'",
            "SSHKey: 'SSH_LEAK'",
            "AWSSecret: 'AWS_LEAK'",
            "OTPKey = 'OTP_LEAK'"
        ].join('\n'))

        for (const leak of ['API_LEAK', 'JWT_LEAK', 'SSH_LEAK', 'AWS_LEAK', 'OTP_LEAK']) {
            expect(redacted).not.toContain(leak)
        }
    })

    it('still keeps lookalikes after relaxing the camel core', () => {
        const redacted = redactSensitiveContent([
            "hotkey: 'ctrl+a'", "HOTKEY: 'ctrl+b'", "keyword: 'search'",
            'monkeypatch: 1', "tokenizer: 'x'", "secretary: 'jane'", "donkey: 'y'"
        ].join('\n'))

        for (const keep of ['ctrl+a', 'ctrl+b', 'search', 'monkeypatch', 'tokenizer', 'secretary', 'donkey']) {
            expect(redacted).toContain(keep)
        }
    })

    it('scrubs an unterminated PEM whose body is one long unwrapped line', () => {
        // The 200-char per-line bound made this fail OPEN: a key written unwrapped on a
        // single line exceeded it, so nothing matched and the body shipped.
        const body = 'B'.repeat(3000)
        const redacted = redactSensitiveContent(`-----BEGIN PRIVATE KEY-----\n${body}`)

        expect(redacted).not.toContain(body)
    })

    it('scrubs a token embedded in a package.json script', () => {
        expect(redactSensitiveContent('"deploy": "gh release upload --token=ghp_leak"'))
            .not.toContain('ghp_leak')
    })

    it('returns falsy input unchanged', () => {
        expect(redactSensitiveContent('')).toBe('')
    })
})

describe('collectConfigFilesForUpload', () => {
    it('captures the entry config, redacted', () => {
        write('wdio.conf.ts', CONFIG_SRC)
        write('shared.conf.ts', 'export const shared = { maxInstances: 5 }')

        const { files, failures } = collectConfigFilesForUpload({} as never)

        expect(failures).toEqual([])
        const entry = files.find((f) => f.name === 'wdio.conf.ts')
        expect(entry).toBeDefined()
        expect(entry!.content).not.toContain('my-real-access-key')
        expect(entry!.content).toContain('accessibility: true')
    })

    it('follows relative imports, resolving a .js specifier to the .ts file on disk', () => {
        write('wdio.conf.ts', CONFIG_SRC)
        write('shared.conf.ts', 'export const shared = { maxInstances: 5 }')

        const { files } = collectConfigFilesForUpload({} as never)

        expect(files.map((f) => f.name).sort()).toEqual(['shared.conf.ts', 'wdio.conf.ts'])
        expect(files.find((f) => f.name === 'shared.conf.ts')!.content).toContain('maxInstances: 5')
    })

    it('redacts imported config files too', () => {
        write('wdio.conf.ts', 'import "./creds.conf.ts"\nexport const config = {}')
        write('creds.conf.ts', 'export const accessKey = "leaked-from-import"')

        const { files } = collectConfigFilesForUpload({} as never)

        expect(files.map((f) => f.content).join('\n')).not.toContain('leaked-from-import')
    })

    it('never follows bare (npm package) specifiers', () => {
        write('wdio.conf.ts', 'import { x } from "@wdio/globals"\nimport y from "dotenv"\nexport const config = {}')

        const { files } = collectConfigFilesForUpload({} as never)

        expect(files.map((f) => f.name)).toEqual(['wdio.conf.ts'])
    })

    it('de-duplicates archive names when two captured files share a basename', () => {
        write('wdio.conf.ts', 'import "./nested/wdio.conf.ts"\nexport const config = {}')
        write('nested/wdio.conf.ts', 'export const config = {}')

        const { files } = collectConfigFilesForUpload({} as never)

        expect(files).toHaveLength(2)
        expect(new Set(files.map((f) => f.name)).size).toBe(2)
    })

    it('reports a soft failure and captures nothing when no config is found', () => {
        const { files, failures } = collectConfigFilesForUpload({} as never)

        expect(files).toEqual([])
        expect(failures).toEqual(['config_not_found'])
    })

    it('skips an oversized config instead of bloating the archive', () => {
        write('wdio.conf.js', 'x'.repeat(1024 * 1024 + 10))

        const { files, failures } = collectConfigFilesForUpload({} as never)

        expect(files).toEqual([])
        expect(failures[0]).toContain('too_large')
    })

    it('never throws on an unreadable config path', () => {
        process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH] = path.join(tmpRoot, 'gone.conf.ts')

        expect(() => collectConfigFilesForUpload({} as never)).not.toThrow()
    })
})

describe('findPackageJsonForUpload', () => {
    it('prefers the package.json next to the resolved config', () => {
        const expected = write('project/package.json', '{"name":"app"}')
        process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH] = write('project/wdio.conf.ts')

        expect(findPackageJsonForUpload()).toBe(expected)
    })

    it('falls back to cwd', () => {
        const expected = write('package.json', '{"name":"app"}')

        expect(findPackageJsonForUpload()).toBe(expected)
    })

    it('walks up from a config kept in a subdirectory (configs/wdio.conf.ts)', () => {
        const expected = write('package.json', '{"name":"app"}')
        process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH] = write('configs/env/wdio.conf.ts')

        expect(findPackageJsonForUpload()).toBe(expected)
    })

    it('picks the closest package.json when nested ones exist', () => {
        write('package.json', '{"name":"monorepo-root"}')
        const closest = write('packages/e2e/package.json', '{"name":"e2e"}')
        process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH] = write('packages/e2e/configs/wdio.conf.ts')

        expect(findPackageJsonForUpload()).toBe(closest)
    })

    it('returns undefined when there is none', () => {
        expect(findPackageJsonForUpload()).toBeUndefined()
    })
})

describe('isAutoCaptureLogsDisabled', () => {
    it('is off by default', () => {
        expect(isAutoCaptureLogsDisabled({})).toBe(false)
        expect(isAutoCaptureLogsDisabled(undefined)).toBe(false)
    })

    it('honours the service option', () => {
        expect(isAutoCaptureLogsDisabled({ disableAutoCaptureLogs: true })).toBe(true)
    })

    it('honours the env var for CI where the config cannot be edited', () => {
        process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS] = 'TRUE'

        expect(isAutoCaptureLogsDisabled({})).toBe(true)
    })
})
