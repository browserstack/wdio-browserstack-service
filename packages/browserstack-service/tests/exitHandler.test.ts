import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { shouldCallCleanup } from '../src/exitHandler.js'
import * as bstackLogger from '../src/bstackLogger.js'
import * as FunnelInstrumentation from '../src/instrumentation/funnelInstrumentation.js'
import PerformanceTester from '../src/instrumentation/performance/performance-tester.js'
import { BROWSERSTACK_TESTHUB_UUID } from '../src/constants.js'

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
