import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { BROWSERSTACK_TESTHUB_JWT, BROWSERSTACK_TESTHUB_UUID } from '../src/constants.js'

// Stable mock fns (survive vi.resetModules, unlike fns created inside a mock factory).
const h = vi.hoisted(() => ({
    exitHookMock: vi.fn(),
    stopBuildUpstreamMock: vi.fn(),
    spawnMock: vi.fn(),
    getConfigMock: vi.fn(),
    isRunningMock: vi.fn(),
}))

vi.mock('async-exit-hook', () => ({ default: h.exitHookMock }))
vi.mock('node:child_process', () => ({ spawn: h.spawnMock }))
vi.mock('../src/util.js', () => ({ stopBuildUpstream: h.stopBuildUpstreamMock }))
vi.mock('../src/config.js', () => ({ default: { getInstance: h.getConfigMock } }))
vi.mock('../src/cli/index.js', () => ({
    BrowserstackCLI: { getInstance: () => ({ isRunning: h.isRunningMock, process: null }) },
}))
vi.mock('../src/bstackLogger.js', () => ({ BStackLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../src/instrumentation/funnelInstrumentation.js', () => ({ saveFunnelData: vi.fn() }))
vi.mock('../src/instrumentation/performance/performance-tester.js', () => ({ default: { isEnabled: vi.fn(() => false) } }))
vi.mock('../src/testOps/testOpsConfig.js', () => ({ default: { getInstance: vi.fn(() => ({ buildHashedId: 'x' })) } }))

// Fresh module per test resets the module-level buildStopInFlight / asyncStopHookRegistered latches.
const loadModule = async () => {
    vi.resetModules()
    return await import('../src/exitHandler.js')
}

describe('exitHandler — async-exit-hook build stop', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        h.isRunningMock.mockReturnValue(false)
        h.stopBuildUpstreamMock.mockResolvedValue({ status: 'success', message: '' })
        process.env[BROWSERSTACK_TESTHUB_UUID] = 'uuid-123'
        process.env[BROWSERSTACK_TESTHUB_JWT] = 'jwt-123'
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as never)
    })

    afterEach(() => {
        exitSpy.mockRestore()
    })

    describe('registration', () => {
        it('registers exactly one async exit hook via async-exit-hook and never calls process.exit', async () => {
            h.getConfigMock.mockReturnValue({ testObservability: { buildStopped: false } })
            const mod = await loadModule()

            mod.setupExitHandlers()

            expect(h.exitHookMock).toHaveBeenCalledTimes(1)
            const registeredHook = h.exitHookMock.mock.calls[0][0]
            expect(typeof registeredHook).toBe('function')
            // Async signature: the hook declares the `done` callback so async-exit-hook awaits it.
            expect(registeredHook.length).toBe(1)
            expect(exitSpy).not.toHaveBeenCalled()
        })

        it('registers the hook only once across repeated setupExitHandlers calls', async () => {
            h.getConfigMock.mockReturnValue({ testObservability: { buildStopped: false } })
            const mod = await loadModule()

            mod.setupExitHandlers()
            mod.setupExitHandlers()

            expect(h.exitHookMock).toHaveBeenCalledTimes(1)
        })

        it('the registered hook drives stopBuildUpstream and releases done() without exiting', async () => {
            const config: any = { testObservability: { buildStopped: false } }
            h.getConfigMock.mockReturnValue(config)
            const mod = await loadModule()
            mod.setupExitHandlers()
            const registeredHook = h.exitHookMock.mock.calls[0][0]

            const done = vi.fn()
            await new Promise<void>((resolve) => {
                done.mockImplementation(() => resolve())
                registeredHook(done)
            })

            expect(h.stopBuildUpstreamMock).toHaveBeenCalledTimes(1)
            expect(done).toHaveBeenCalledTimes(1)
            expect(config.testObservability.buildStopped).toBe(true)
            expect(exitSpy).not.toHaveBeenCalled()
        })
    })

    describe('stopBuildOnShutdown guards', () => {
        it('calls stopBuildUpstream once and marks the build stopped on success', async () => {
            const config: any = { testObservability: { buildStopped: false } }
            h.getConfigMock.mockReturnValue(config)
            const mod = await loadModule()

            await mod.stopBuildOnShutdown()

            expect(h.stopBuildUpstreamMock).toHaveBeenCalledTimes(1)
            expect(config.testObservability.buildStopped).toBe(true)
            expect(exitSpy).not.toHaveBeenCalled()
        })

        it('does not mark the build stopped when stopBuildUpstream does not return success', async () => {
            const config: any = { testObservability: { buildStopped: false } }
            h.getConfigMock.mockReturnValue(config)
            h.stopBuildUpstreamMock.mockResolvedValue({ status: 'error', message: 'boom' })
            const mod = await loadModule()

            await mod.stopBuildOnShutdown()

            expect(h.stopBuildUpstreamMock).toHaveBeenCalledTimes(1)
            expect(config.testObservability.buildStopped).toBe(false)
        })

        it('never throws and does not call stopBuildUpstream when BrowserStackConfig is undefined', async () => {
            h.getConfigMock.mockReturnValue(undefined)
            const mod = await loadModule()

            await expect(mod.stopBuildOnShutdown()).resolves.toBeUndefined()
            expect(h.stopBuildUpstreamMock).not.toHaveBeenCalled()
        })

        it('never throws when stopBuildUpstream rejects', async () => {
            h.getConfigMock.mockReturnValue({ testObservability: { buildStopped: false } })
            h.stopBuildUpstreamMock.mockRejectedValue(new Error('network down'))
            const mod = await loadModule()

            await expect(mod.stopBuildOnShutdown()).resolves.toBeUndefined()
        })

        it('skips the stop when the CLI is running (CLI owns its own build lifecycle)', async () => {
            h.getConfigMock.mockReturnValue({ testObservability: { buildStopped: false } })
            h.isRunningMock.mockReturnValue(true)
            const mod = await loadModule()

            await mod.stopBuildOnShutdown()

            expect(h.stopBuildUpstreamMock).not.toHaveBeenCalled()
        })

        it('skips the stop when the TestHub UUID/JWT are absent', async () => {
            h.getConfigMock.mockReturnValue({ testObservability: { buildStopped: false } })
            delete process.env[BROWSERSTACK_TESTHUB_UUID]
            delete process.env[BROWSERSTACK_TESTHUB_JWT]
            const mod = await loadModule()

            await mod.stopBuildOnShutdown()

            expect(h.stopBuildUpstreamMock).not.toHaveBeenCalled()
        })

        it('skips the stop when the build was already stopped', async () => {
            h.getConfigMock.mockReturnValue({ testObservability: { buildStopped: true } })
            const mod = await loadModule()

            await mod.stopBuildOnShutdown()

            expect(h.stopBuildUpstreamMock).not.toHaveBeenCalled()
        })

        it('does not send a second stop once one is already in flight/done (latch)', async () => {
            const config: any = { testObservability: { buildStopped: false } }
            h.getConfigMock.mockReturnValue(config)
            const mod = await loadModule()

            await mod.stopBuildOnShutdown()
            // build now marked stopped -> second call is a no-op
            await mod.stopBuildOnShutdown()

            expect(h.stopBuildUpstreamMock).toHaveBeenCalledTimes(1)
        })
    })
})
