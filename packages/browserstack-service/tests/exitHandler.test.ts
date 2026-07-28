import { describe, expect, it, vi, beforeEach } from 'vitest'

import { BROWSERSTACK_TESTHUB_JWT, BROWSERSTACK_TESTHUB_UUID } from '../src/constants.js'

// Stable mock fns (survive vi.resetModules, unlike fns created inside a mock factory).
const h = vi.hoisted(() => ({
    spawnSyncMock: vi.fn(),
    spawnMock: vi.fn(),
    getConfigMock: vi.fn(),
    isRunningMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({ spawnSync: h.spawnSyncMock, spawn: h.spawnMock }))
vi.mock('../src/config.js', () => ({ default: { getInstance: h.getConfigMock } }))
vi.mock('../src/cli/index.js', () => ({
    BrowserstackCLI: { getInstance: () => ({ isRunning: h.isRunningMock, process: null }) },
}))
vi.mock('../src/cli/apiUtils.js', () => ({ default: { DATA_ENDPOINT: 'https://collector-observability.browserstack.com' } }))
vi.mock('../src/bstackLogger.js', () => ({ BStackLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../src/instrumentation/funnelInstrumentation.js', () => ({ saveFunnelData: vi.fn() }))
vi.mock('../src/instrumentation/performance/performance-tester.js', () => ({ default: { isEnabled: vi.fn(() => false) } }))
vi.mock('../src/testOps/testOpsConfig.js', () => ({ default: { getInstance: vi.fn(() => ({ buildHashedId: 'x' })) } }))

// SDK-7061: stopBuildSyncBlocking performs the synchronous, blocking build-stop on process
// shutdown. Fresh module per test resets the module-level buildStopSentOnSignal latch.
const loadStopBuildSyncBlocking = async () => {
    vi.resetModules()
    const mod = await import('../src/exitHandler.js')
    return mod.stopBuildSyncBlocking
}

describe('stopBuildSyncBlocking', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        h.isRunningMock.mockReturnValue(false)
        h.spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '', signal: null } as any)
        process.env[BROWSERSTACK_TESTHUB_UUID] = 'uuid-123'
        process.env[BROWSERSTACK_TESTHUB_JWT] = 'jwt-123'
    })

    it('early-returns without throwing or spawning when BrowserStackConfig is undefined', async () => {
        h.getConfigMock.mockReturnValue(undefined)
        const stopBuildSyncBlocking = await loadStopBuildSyncBlocking()

        expect(() => stopBuildSyncBlocking('uncaughtException')).not.toThrow()
        expect(h.spawnSyncMock).not.toHaveBeenCalled()
    })

    it('spawns the blocking stop child exactly once and marks the build stopped on success', async () => {
        const config: any = { testObservability: { buildStopped: false } }
        h.getConfigMock.mockReturnValue(config)
        const stopBuildSyncBlocking = await loadStopBuildSyncBlocking()

        stopBuildSyncBlocking('exit')

        expect(h.spawnSyncMock).toHaveBeenCalledTimes(1)
        const [bin, args] = h.spawnSyncMock.mock.calls[0]
        expect(bin).toEqual(process.execPath)
        expect(args[0]).toEqual('-e')
        expect(String(args[1])).toContain('/api/v1/builds/')
        expect(config.testObservability.buildStopped).toBe(true)
    })

    it('does not mark the build stopped when the spawnSync child exits non-zero', async () => {
        const config: any = { testObservability: { buildStopped: false } }
        h.getConfigMock.mockReturnValue(config)
        h.spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'fail', signal: null } as any)
        const stopBuildSyncBlocking = await loadStopBuildSyncBlocking()

        stopBuildSyncBlocking('exit')

        expect(h.spawnSyncMock).toHaveBeenCalledTimes(1)
        expect(config.testObservability.buildStopped).toBe(false)
    })

    it('skips the stop when the CLI is running (CLI owns its own build lifecycle)', async () => {
        h.getConfigMock.mockReturnValue({ testObservability: { buildStopped: false } })
        h.isRunningMock.mockReturnValue(true)
        const stopBuildSyncBlocking = await loadStopBuildSyncBlocking()

        stopBuildSyncBlocking('exit')

        expect(h.spawnSyncMock).not.toHaveBeenCalled()
    })

    it('skips the stop when the TestHub UUID/JWT are absent', async () => {
        h.getConfigMock.mockReturnValue({ testObservability: { buildStopped: false } })
        delete process.env[BROWSERSTACK_TESTHUB_UUID]
        delete process.env[BROWSERSTACK_TESTHUB_JWT]
        const stopBuildSyncBlocking = await loadStopBuildSyncBlocking()

        stopBuildSyncBlocking('exit')

        expect(h.spawnSyncMock).not.toHaveBeenCalled()
    })

    it('skips the stop when the build was already stopped', async () => {
        h.getConfigMock.mockReturnValue({ testObservability: { buildStopped: true } })
        const stopBuildSyncBlocking = await loadStopBuildSyncBlocking()

        stopBuildSyncBlocking('exit')

        expect(h.spawnSyncMock).not.toHaveBeenCalled()
    })
})
