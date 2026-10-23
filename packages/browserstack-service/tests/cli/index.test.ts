import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as bstackLogger from '../../src/bstackLogger.js'
import { BStackLogger } from '../../src/cli/cliLogger.js'

import { BrowserstackCLI } from '../../src/cli/index.js'

const bstackLoggerSpy = vi.spyOn(bstackLogger.BStackLogger, 'logToFile')
bstackLoggerSpy.mockImplementation(() => {})

describe('BrowserstackCLI bootstrap error surfacing', () => {
    let instance: any
    let loggerErrorSpy: ReturnType<typeof vi.spyOn>
    let loggerDebugSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        instance = BrowserstackCLI.getInstance()
        loggerErrorSpy = vi.spyOn(BStackLogger, 'error').mockImplementation(() => {})
        loggerDebugSpy = vi.spyOn(BStackLogger, 'debug').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
        // Reset singleton fields touched by loadModules tests so each case
        // starts from a known state.
        instance.binSessionId = null
        instance.config = {}
        instance.modules = {}
    })

    describe('logBuildErrors', () => {
        it('is a no-op when testhub.errors is absent', () => {
            instance.logBuildErrors({ binSessionId: 'b1', config: '{}' } as any)
            expect(loggerErrorSpy).not.toHaveBeenCalled()
        })

        it('is a no-op when testhub.errors is empty', () => {
            instance.logBuildErrors({
                binSessionId: 'b1',
                config: '{}',
                testhub: { errors: Buffer.from('') }
            } as any)
            expect(loggerErrorSpy).not.toHaveBeenCalled()
        })

        it('logs each entry as [Build] <code>: <message>', () => {
            const errors = {
                ERROR_ACCESS_DENIED: { message: 'Access to BrowserStack denied due to incorrect credentials.', type: 'info' },
                ERROR_OBSERVABILITY_NOT_ALLOWED: { message: 'Observability is not enabled for this account.', type: 'error' }
            }
            instance.logBuildErrors({
                binSessionId: 'b1',
                config: '{}',
                testhub: { errors: Buffer.from(JSON.stringify(errors)) }
            } as any)
            expect(loggerErrorSpy).toHaveBeenCalledWith('[Build] ERROR_ACCESS_DENIED: Access to BrowserStack denied due to incorrect credentials.')
            expect(loggerErrorSpy).toHaveBeenCalledWith('[Build] ERROR_OBSERVABILITY_NOT_ALLOWED: Observability is not enabled for this account.')
            expect(loggerErrorSpy).toHaveBeenCalledTimes(2)
        })

        it('emits a debug log and does NOT throw when testhub.errors is unparseable', () => {
            instance.logBuildErrors({
                binSessionId: 'b1',
                config: '{}',
                testhub: { errors: Buffer.from('{not-valid-json') }
            } as any)
            expect(loggerErrorSpy).not.toHaveBeenCalled()
            expect(loggerDebugSpy).toHaveBeenCalled()
        })
    })

    describe('loadModules integration', () => {
        it('logs build errors BEFORE the downstream apis dereference fails', () => {
            // On an auth-failure response the binary returns an empty
            // config string. setConfig parses it as `{}`, leaving
            // this.config.apis undefined, so APIUtils.updateURLSForGRR
            // throws a TypeError when it dereferences `apis.automate`.
            // The PR's invariant is that the [Build] error line is
            // logged BEFORE that downstream throw, so the user sees the
            // actionable cause first.
            const errors = {
                ERROR_ACCESS_DENIED: { message: 'Access to BrowserStack denied due to incorrect credentials.', type: 'info' }
            }
            const response = {
                binSessionId: 'b1',
                config: '{}',
                testhub: { errors: Buffer.from(JSON.stringify(errors)) }
            } as any
            try {
                instance.loadModules(response)
            } catch {
                // expected — updateURLSForGRR throws on missing apis
            }
            expect(loggerErrorSpy).toHaveBeenCalledWith('[Build] ERROR_ACCESS_DENIED: Access to BrowserStack denied due to incorrect credentials.')
        })
    })

    describe('applyServerConfig', () => {
        afterEach(() => {
            instance.options = {}
            instance.serverConfigKeys = []
            instance.modulesLoaded = false
        })

        const configWith = (extra: Record<string, unknown>) => JSON.stringify({ apis: {}, ...extra })

        it('merges exactly the listed keys into the service options', () => {
            const options = { parallelsPerPlatform: 1, buildName: 'local', setSessionName: true }
            instance.options = options
            instance.setConfig({ config: configWith({
                serverSdkConfig: { parallelsPerPlatform: 3, buildName: 'echo', testContextOptions: { skipSessionName: true } },
                serverSdkConfigKeys: ['parallelsPerPlatform', 'testContextOptions'],
            }) } as any)
            instance.applyServerConfig()
            expect(options).toEqual({ parallelsPerPlatform: 3, buildName: 'local', setSessionName: false })
            expect(instance.serverConfigKeys).toEqual(['parallelsPerPlatform', 'testContextOptions'])
        })

        it('drops a server sessionNameFormat from the binary config, which can only be a string', () => {
            instance.options = { setSessionName: false }
            instance.setConfig({ config: configWith({
                testContextOptions: { skipSessionName: false, sessionNameFormat: 'srv-fmt' },
                serverSdkConfig: { testContextOptions: { skipSessionName: false, sessionNameFormat: 'srv-fmt' } },
                serverSdkConfigKeys: ['testContextOptions'],
            }) } as any)
            instance.applyServerConfig()
            expect(instance.config.testContextOptions).toEqual({ skipSessionName: false })
            expect(instance.options).toEqual({ setSessionName: true })
        })

        it('leaves the binary config testContextOptions alone without an override', () => {
            instance.setConfig({ config: configWith({ testContextOptions: { skipSessionName: false, sessionNameFormat: '' } }) } as any)
            instance.applyServerConfig()
            expect(instance.config.testContextOptions).toEqual({ skipSessionName: false, sessionNameFormat: '' })
        })

        it('changes nothing without a key list, as from an older binary', () => {
            const options = { parallelsPerPlatform: 1 }
            instance.options = options
            for (const extra of [{ serverSdkConfig: { parallelsPerPlatform: 3 } }, { serverSdkConfig: { parallelsPerPlatform: 3 }, serverSdkConfigKeys: 'parallelsPerPlatform' }, {}]) {
                instance.setConfig({ config: configWith(extra) } as any)
                instance.applyServerConfig()
            }
            expect(options).toEqual({ parallelsPerPlatform: 1 })
            expect(instance.serverConfigKeys).toEqual([])
        })

        it('keeps the local options when the merge fails', () => {
            const options = { parallelsPerPlatform: 1 }
            instance.options = options
            instance.config = { serverSdkConfig: { parallelsPerPlatform: 3 }, serverSdkConfigKeys: ['parallelsPerPlatform'] }
            vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw new Error('boom') })
            instance.applyServerConfig()
            expect(options).toEqual({ parallelsPerPlatform: 1 })
            expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining('applyServerConfig: keeping the local config'))
        })

        it('runs right after setConfig in loadModules, and again for the options of a repeated load', () => {
            const response = { binSessionId: 'b1', config: configWith({ serverSdkConfig: { parallelsPerPlatform: 2 }, serverSdkConfigKeys: ['parallelsPerPlatform'] }) } as any
            const mainOptions = { parallelsPerPlatform: 1 }
            instance.options = mainOptions
            try {
                instance.loadModules(response)
            } catch {
                // modules need a full bin session; only the merge is under test
            }
            expect(mainOptions.parallelsPerPlatform).toBe(2)

            const workerOptions = { parallelsPerPlatform: 1 }
            instance.options = workerOptions
            instance.modulesLoaded = true
            instance.loadModules(response)
            expect(workerOptions.parallelsPerPlatform).toBe(2)
        })
    })

    // SDK-6821: apis arrives under the sessionData bucket (flat kept for backward
    // compat until every SDK migrates). The bucket-only case is the Phase-4 shape —
    // the one a broken hoist cannot mask via the flat fallback.
    describe('setConfig sessionData apis hoist (SDK-6821)', () => {
        const setConfigWith = (config: Record<string, unknown>) =>
            instance.setConfig({ config: JSON.stringify(config) } as any)

        it('resolves apis from sessionData alone (future caps-only echo)', () => {
            setConfigWith({ sessionData: { apis: { automate: { api: 'https://api.browserstack.com' } } } })
            expect(instance.config.apis).toEqual({ automate: { api: 'https://api.browserstack.com' } })
        })

        it('prefers sessionData.apis over a stale flat apis', () => {
            setConfigWith({
                apis: { automate: { api: 'https://stale.example' } },
                sessionData: { apis: { automate: { api: 'https://fresh.example' } } }
            })
            expect(instance.config.apis).toEqual({ automate: { api: 'https://fresh.example' } })
        })

        it('keeps the flat apis when no bucket is present (old binary)', () => {
            setConfigWith({ apis: { automate: { api: 'https://flat-only.example' } } })
            expect(instance.config.apis).toEqual({ automate: { api: 'https://flat-only.example' } })
        })
    })
})
