import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { GrpcClient } from '../../src/cli/grpcClient.js'

vi.mock('../../src/grpc/index.js', () => ({
    StopBinSessionRequestConstructor: { create: (fields: Record<string, unknown>) => ({ ...fields }) }
}))

vi.mock('../../src/cli/cliUtils.js', () => ({
    CLIUtils: { getClientWorkerId: vi.fn(() => '1-123') }
}))

vi.mock('../../src/cli/cliLogger.js', () => ({
    BStackLogger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}))

vi.mock('../../src/instrumentation/performance/performance-tester.js', () => ({
    default: { start: vi.fn(), end: vi.fn() }
}))

describe('GrpcClient.stopBinSession', () => {
    let client: GrpcClient
    let stopBinSession: ReturnType<typeof vi.fn>

    beforeEach(() => {
        stopBinSession = vi.fn((_req: unknown, cb: (err: unknown, res: unknown) => void) => cb(null, { done: true }))
        client = new GrpcClient()
        client.binSessionId = 'bin-1'
        client.client = { stopBinSession } as any
    })

    afterEach(() => {
        delete process.env.BROWSERSTACK_SDK_KILL_SIGNAL
        vi.clearAllMocks()
    })

    it('includes exitSignal and exitReason when the kill-signal env is set', async () => {
        process.env.BROWSERSTACK_SDK_KILL_SIGNAL = 'SIGTERM'
        await client.stopBinSession()
        expect(stopBinSession.mock.calls[0][0]).toMatchObject({
            binSessionId: 'bin-1',
            exitSignal: 'SIGTERM',
            exitReason: 'user_killed'
        })
    })

    it('omits exitSignal and exitReason when the kill-signal env is absent', async () => {
        await client.stopBinSession()
        const request = stopBinSession.mock.calls[0][0] as Record<string, unknown>
        expect(request.exitSignal).toBeUndefined()
        expect(request.exitReason).toBeUndefined()
    })
})
