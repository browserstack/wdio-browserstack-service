import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { shouldCallCleanup, setupExitHandlers } from '../src/exitHandler.js'
import BrowserStackConfig from '../src/config.js'
import * as bstackLogger from '../src/bstackLogger.js'
import * as FunnelInstrumentation from '../src/instrumentation/funnelInstrumentation.js'
import PerformanceTester from '../src/instrumentation/performance/performance-tester.js'
import { BROWSERSTACK_TESTHUB_UUID } from '../src/constants.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }))
vi.mock('../src/cli/index.js', () => ({
    BrowserstackCLI: { getInstance: () => ({ isRunning: () => false, process: null }) }
}))

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})
vi.spyOn(FunnelInstrumentation, 'saveFunnelData').mockReturnValue('funnel.json')
vi.spyOn(PerformanceTester, 'isEnabled').mockReturnValue(false)

function makeConfig(overrides: Record<string, unknown> = {}) {
    return {
        userName: 'user',
        accessKey: 'key',
        funnelDataSent: true,
        logsUploaded: false,
        sdkRunID: 'run-123',
        testObservability: { buildStopped: false },
        ...overrides
    } as any
}

describe('shouldCallCleanup', () => {
    let originalEnv: NodeJS.ProcessEnv

    beforeEach(() => {
        originalEnv = process.env
        process.env = {}
    })

    afterEach(() => {
        process.env = originalEnv
    })

    it('pushes --uploadLogs with the testhub uuid when logs are not yet uploaded', () => {
        process.env[BROWSERSTACK_TESTHUB_UUID] = 'testhub-uuid'
        const args = shouldCallCleanup(makeConfig())
        expect(args).toContain('--uploadLogs')
        expect(args[args.indexOf('--uploadLogs') + 1]).toBe('testhub-uuid')
    })

    it('falls back to sdkRunID when the testhub uuid is absent', () => {
        const args = shouldCallCleanup(makeConfig())
        expect(args[args.indexOf('--uploadLogs') + 1]).toBe('run-123')
    })

    it('omits --uploadLogs when logs were already uploaded', () => {
        const args = shouldCallCleanup(makeConfig({ logsUploaded: true }))
        expect(args).not.toContain('--uploadLogs')
    })

    it('omits --uploadLogs when credentials are missing', () => {
        const args = shouldCallCleanup(makeConfig({ userName: undefined, accessKey: undefined }))
        expect(args).not.toContain('--uploadLogs')
    })
})

describe('setupExitHandlers forced exit', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.useFakeTimers()
        exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
        vi.spyOn(BrowserStackConfig, 'getInstance').mockReturnValue({ setKillSignal: vi.fn() } as any)
    })

    afterEach(() => {
        process.removeAllListeners('SIGTERM')
        exitSpy.mockRestore()
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('forces the conventional 128+n exit once the grace window elapses', () => {
        setupExitHandlers()
        process.emit('SIGTERM' as NodeJS.Signals)

        expect(exitSpy).not.toHaveBeenCalled()

        vi.advanceTimersByTime(5000)

        expect(exitSpy).toHaveBeenCalledWith(143)
    })
})
