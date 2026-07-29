import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { setupExitHandlers, shouldCallCleanup } from '../src/exitHandler.js'
import BrowserStackConfig from '../src/config.js'
import PerformanceTester from '../src/instrumentation/performance/performance-tester.js'
import { BROWSERSTACK_TESTHUB_UUID, BROWSERSTACK_KILL_SIGNAL } from '../src/constants.js'

describe('shouldCallCleanup uploadLogs rescue', () => {
    let originalEnv: NodeJS.ProcessEnv

    const baseConfig = () => ({
        userName: 'user',
        accessKey: 'key',
        funnelDataSent: true,
        logsUploaded: false,
        sdkRunID: 'run-id',
        testObservability: { buildStopped: true }
    })

    const uploadLogsUuid = (args: string[]) => {
        const index = args.indexOf('--uploadLogs')
        return index === -1 ? undefined : args[index + 1]
    }

    beforeEach(() => {
        originalEnv = process.env
        process.env = {}
        vi.spyOn(PerformanceTester, 'isEnabled').mockReturnValue(false)
    })

    afterEach(() => {
        process.env = originalEnv
        vi.restoreAllMocks()
    })

    it('pushes --uploadLogs with the testhub uuid when creds present and logs not uploaded', () => {
        process.env[BROWSERSTACK_TESTHUB_UUID] = 'testhub-uuid'
        const args = shouldCallCleanup(baseConfig() as any)
        expect(uploadLogsUuid(args)).toBe('testhub-uuid')
    })

    it('falls back to config.sdkRunID when the testhub uuid env is absent', () => {
        const args = shouldCallCleanup(baseConfig() as any)
        expect(uploadLogsUuid(args)).toBe('run-id')
    })

    it('does not push --uploadLogs when logs were already uploaded', () => {
        process.env[BROWSERSTACK_TESTHUB_UUID] = 'testhub-uuid'
        const args = shouldCallCleanup({ ...baseConfig(), logsUploaded: true } as any)
        expect(args).not.toContain('--uploadLogs')
    })

    it('does not push --uploadLogs when credentials are missing', () => {
        process.env[BROWSERSTACK_TESTHUB_UUID] = 'testhub-uuid'
        const args = shouldCallCleanup({ ...baseConfig(), userName: undefined, accessKey: undefined } as any)
        expect(args).not.toContain('--uploadLogs')
    })
})

describe('setupExitHandlers forced exit', () => {
    const EVENTS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGQUIT', 'SIGBREAK', 'exit'] as const
    let added: Array<[string, (...a: any[]) => void]>
    let exitSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        BrowserStackConfig.getInstance({} as any, {} as any)
        vi.useFakeTimers()
        exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any)
        // Register the handlers, then track only the listeners we added so afterEach
        // can remove them without touching the runner's own signal/exit listeners.
        const before = new Map(EVENTS.map((e) => [e, process.listeners(e as any).slice()]))
        setupExitHandlers()
        added = []
        for (const e of EVENTS) {
            for (const l of process.listeners(e as any)) {
                if (!before.get(e)!.includes(l)) {
                    added.push([e, l as any])
                }
            }
        }
    })

    afterEach(() => {
        for (const [e, l] of added) {
            process.removeListener(e as any, l)
        }
        delete process.env[BROWSERSTACK_KILL_SIGNAL]
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('forces the conventional 128+n exit after the grace window on SIGTERM', () => {
        process.emit('SIGTERM' as any)
        expect(exitSpy).not.toHaveBeenCalled()
        vi.advanceTimersByTime(5000)
        expect(exitSpy).toHaveBeenCalledWith(143)
    })
})
