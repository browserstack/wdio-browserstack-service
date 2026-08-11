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

    it('falls back to the argv positional for the bare `wdio <config>` form', () => {
        const expected = write('custom.conf.mjs')
        process.argv = ['node', 'wdio', './custom.conf.mjs']

        expect(resolveWdioConfigPath({} as never))
            .toEqual({ configPath: expected, strategy: 'argv_positional' })
    })

    it('does not mistake a --spec value for the config positional', () => {
        const expected = write('wdio.conf.ts')
        write('test/login.e2e.js')
        process.argv = ['node', 'wdio', 'run', './wdio.conf.ts', '--spec', './test/login.e2e.js']

        expect(resolveWdioConfigPath({} as never))
            .toEqual({ configPath: expected, strategy: 'argv_positional' })
    })

    it('skips the `run` subcommand when scanning argv', () => {
        write('run')
        const expected = write('wdio.conf.cts')
        process.argv = ['node', 'wdio', 'run', './wdio.conf.cts']

        expect(resolveWdioConfigPath({} as never).configPath).toBe(expected)
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

    it('accepts a single custom *.conf.* file as unambiguous', () => {
        const expected = write('e2e.conf.ts')

        expect(resolveWdioConfigPath({} as never))
            .toEqual({ configPath: expected, strategy: 'single_conf_scan' })
    })

    it('captures nothing when several custom configs are present', () => {
        write('android.conf.ts')
        write('ios.conf.ts')

        expect(resolveWdioConfigPath({} as never)).toEqual({ reason: 'config_ambiguous' })
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
