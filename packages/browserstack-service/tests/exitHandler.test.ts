import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { shouldCallCleanup } from '../src/exitHandler.js'
import PerformanceTester from '../src/instrumentation/performance/performance-tester.js'
import { BROWSERSTACK_TESTHUB_UUID } from '../src/constants.js'

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
