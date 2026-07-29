import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/fetchWrapper.js', () => ({
    default: vi.fn(async () => ({ text: async () => '{}' }))
}))
vi.mock('../../src/data-store.js', () => ({
    getDataFromWorkers: vi.fn(() => []),
    saveWorkerData: vi.fn()
}))

import { sendStart, sendFinish } from '../../src/instrumentation/funnelInstrumentation.js'
import fetchWrap from '../../src/fetchWrapper.js'
import { getDataFromWorkers } from '../../src/data-store.js'

const baseConfig = {
    userName: 'user',
    accessKey: 'key',
    testObservability: { enabled: true },
    framework: 'mocha',
    buildName: 'build',
    buildIdentifier: 'id'
}

const lastRequestBody = () => {
    const calls = vi.mocked(fetchWrap).mock.calls
    return JSON.parse((calls[calls.length - 1][1] as { body: string }).body)
}

describe('funnel kill-signal finish metadata', () => {
    beforeEach(() => {
        vi.mocked(getDataFromWorkers).mockReturnValue([])
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    it('stamps user_killed finishedMetadata and lets kill win over session_reloaded', async () => {
        vi.mocked(getDataFromWorkers).mockReturnValue([{ reloadHappened: true }] as any)
        await sendFinish({ ...baseConfig, killSignal: 'SIGINT' } as any)
        expect(lastRequestBody().event_properties.finishedMetadata).toEqual({ reason: 'user_killed', signal: 'SIGINT' })
    })

    it('marks funnel data sent only for the finish event, not the attempt event', async () => {
        const attemptConfig = { ...baseConfig, sentFunnelData: vi.fn() }
        await sendStart(attemptConfig as any)
        expect(attemptConfig.sentFunnelData).not.toHaveBeenCalled()

        const finishConfig = { ...baseConfig, sentFunnelData: vi.fn() }
        await sendFinish(finishConfig as any)
        expect(finishConfig.sentFunnelData).toHaveBeenCalledTimes(1)
    })
})
