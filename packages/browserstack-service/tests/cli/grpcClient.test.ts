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

describe('GrpcClient.stopBinSession customer-visible summary entries', () => {
    let client: GrpcClient
    let stdoutSpy: ReturnType<typeof vi.spyOn>
    let stderrSpy: ReturnType<typeof vi.spyOn>

    const respondWith = (response: unknown) => {
        client.client = {
            stopBinSession: vi.fn((_req: unknown, cb: (err: unknown, res: unknown) => void) => cb(null, response))
        } as any
    }

    beforeEach(() => {
        client = new GrpcClient()
        client.binSessionId = 'bin-1'
        stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    })

    afterEach(() => {
        stdoutSpy.mockRestore()
        stderrSpy.mockRestore()
        vi.clearAllMocks()
    })

    it('writes the body verbatim to stdout for an info entry', async () => {
        respondWith({ entries: [{ entryType: 'version_nudge', severity: 'info', body: 'line one\nline two' }] })
        await client.stopBinSession()
        expect(stdoutSpy).toHaveBeenCalledWith('line one\nline two\n')
        expect(stderrSpy).not.toHaveBeenCalled()
    })

    it('routes warn and error entries to stderr', async () => {
        respondWith({ entries: [
            { entryType: 'version_nudge', severity: 'warn', body: 'outdated' },
            { entryType: 'version_nudge', severity: 'error', body: 'deprecated' }
        ] })
        await client.stopBinSession()
        expect(stderrSpy).toHaveBeenCalledWith('outdated\n')
        expect(stderrSpy).toHaveBeenCalledWith('deprecated\n')
        expect(stdoutSpy).not.toHaveBeenCalled()
    })

    it('treats the server\'s "warning" spelling as an error stream', async () => {
        respondWith({ entries: [{ entryType: 'version_nudge', severity: 'warning', body: 'outdated' }] })
        await client.stopBinSession()
        expect(stderrSpy).toHaveBeenCalledWith('outdated\n')
    })

    it('sends an unknown severity to stdout so CI stderr watchers are not tripped', async () => {
        respondWith({ entries: [{ entryType: 'version_nudge', severity: 'bogus', body: 'body' }] })
        await client.stopBinSession()
        expect(stdoutSpy).toHaveBeenCalledWith('body\n')
        expect(stderrSpy).not.toHaveBeenCalled()
    })

    it('writes nothing when entries are absent, empty, or bodiless', async () => {
        for (const response of [{ done: true }, { entries: [] }, { entries: [{ severity: 'warn', body: '' }] }]) {
            respondWith(response)
            await client.stopBinSession()
        }
        expect(stdoutSpy).not.toHaveBeenCalled()
        expect(stderrSpy).not.toHaveBeenCalled()
    })

    it('still returns the response when rendering throws', async () => {
        stdoutSpy.mockImplementation(() => {
            throw new Error('stream closed')
        })
        respondWith({ entries: [{ severity: 'info', body: 'body' }], done: true })
        await expect(client.stopBinSession()).resolves.toMatchObject({ done: true })
    })
})
