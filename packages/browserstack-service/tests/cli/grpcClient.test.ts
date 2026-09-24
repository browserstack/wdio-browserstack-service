import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { GrpcClient } from '../../src/cli/grpcClient.js'
import { BStackLogger } from '../../src/cli/cliLogger.js'

vi.mock('../../src/grpc/index.js', () => ({
    StopBinSessionRequestConstructor: { create: (fields: Record<string, unknown>) => ({ ...fields }) },
    ExecutionContextConstructor: { create: (fields: Record<string, unknown>) => ({ ...fields }) },
    LogCreatedEventRequestConstructor: { create: (fields: Record<string, unknown>) => ({ ...fields }) },
    // eslint-disable-next-line camelcase
    LogCreatedEventRequest_LogEntryConstructor: { create: (fields: Record<string, unknown>) => ({ ...fields }) }
}))

vi.mock('../../src/cli/cliUtils.js', () => ({
    CLIUtils: { getClientWorkerId: vi.fn(() => '1-123') }
}))

vi.mock('../../src/cli/cliLogger.js', () => ({
    BStackLogger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn(), logToFile: vi.fn() }
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
        expect(stderrSpy).toHaveBeenCalledWith('\x1b[1;33moutdated\x1b[0m\n')
        expect(stderrSpy).toHaveBeenCalledWith('\x1b[1;31mdeprecated\x1b[0m\n')
        expect(stdoutSpy).not.toHaveBeenCalled()
    })

    it('treats the server\'s "warning" spelling as an error stream', async () => {
        respondWith({ entries: [{ entryType: 'version_nudge', severity: 'warning', body: 'outdated' }] })
        await client.stopBinSession()
        expect(stderrSpy).toHaveBeenCalledWith('\x1b[1;33moutdated\x1b[0m\n')
    })

    it('tints a warn block yellow and an error block red, line by line', async () => {
        const body = '────\n  Title\n\n  Detail\n────'
        respondWith({ entries: [
            { entryType: 'version_nudge', severity: 'warn', body },
            { entryType: 'version_nudge', severity: 'error', body }
        ] })
        await client.stopBinSession()

        // Borders take the base tint and the first line carrying text is emphasised.
        // Blank lines are left alone, and every tinted line closes its own reset, so a
        // truncated write cannot leave the terminal stuck in colour.
        expect(stderrSpy).toHaveBeenCalledWith(
            '\x1b[33m────\x1b[0m\n\x1b[1;33m  Title\x1b[0m\n\n'
            + '\x1b[33m  Detail\x1b[0m\n\x1b[33m────\x1b[0m\n'
        )
        expect(stderrSpy).toHaveBeenCalledWith(
            '\x1b[31m────\x1b[0m\n\x1b[1;31m  Title\x1b[0m\n\n'
            + '\x1b[31m  Detail\x1b[0m\n\x1b[31m────\x1b[0m\n'
        )
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

    it('archives via logToFile only, so the block is never printed twice', async () => {
        respondWith({ entries: [
            { entryType: 'version_nudge', severity: 'warning', body: 'outdated' },
            { entryType: 'version_nudge', severity: 'error', body: 'deprecated' },
            { entryType: 'version_nudge', severity: 'info', body: 'notice' }
        ] })
        await client.stopBinSession()

        // logToFile writes to the log file only. info/warn/error additionally
        // call @wdio/logger, which writes to the console — using them here
        // would duplicate the block the stream writes above already emitted.
        expect(BStackLogger.logToFile).toHaveBeenCalledWith('outdated', 'warn')
        expect(BStackLogger.logToFile).toHaveBeenCalledWith('deprecated', 'error')
        expect(BStackLogger.logToFile).toHaveBeenCalledWith('notice', 'info')
        // The console-writing helpers must never receive a body. (They are still
        // used for unrelated lines such as "StopBinSession successful".)
        for (const body of ['outdated', 'deprecated', 'notice']) {
            expect(BStackLogger.warn).not.toHaveBeenCalledWith(body)
            expect(BStackLogger.error).not.toHaveBeenCalledWith(body)
            expect(BStackLogger.info).not.toHaveBeenCalledWith(body)
        }
    })

    it('keeps rendering and archiving the entries after one whose write throws', async () => {
        // The catch is scoped per entry, not around the loop: a stream that
        // rejects entry one must not silently drop entries two and three.
        stderrSpy.mockImplementation((chunk: any) => {
            if (String(chunk).includes('first')) {
                throw new Error('stream closed')
            }
            return true
        })

        respondWith({ entries: [
            { entryType: 'version_nudge', severity: 'warn', body: 'first' },
            { entryType: 'version_nudge', severity: 'warn', body: 'second' },
            { entryType: 'version_nudge', severity: 'info', body: 'third' }
        ] })
        await client.stopBinSession()

        expect(stderrSpy).toHaveBeenCalledWith('\x1b[1;33msecond\x1b[0m\n')
        expect(stdoutSpy).toHaveBeenCalledWith('third\n')
        // Archival runs before the stream write, so even the entry whose write
        // threw is still kept in the log directory.
        expect(BStackLogger.logToFile).toHaveBeenCalledWith('first', 'warn')
        expect(BStackLogger.logToFile).toHaveBeenCalledWith('second', 'warn')
        expect(BStackLogger.logToFile).toHaveBeenCalledWith('third', 'info')
    })

    it('still returns the response when rendering throws', async () => {
        stdoutSpy.mockImplementation(() => {
            throw new Error('stream closed')
        })
        respondWith({ entries: [{ severity: 'info', body: 'body' }], done: true })
        await expect(client.stopBinSession()).resolves.toMatchObject({ done: true })
    })
})

describe('GrpcClient.logCreatedEvent', () => {
    let client: GrpcClient
    let logCreatedEvent: ReturnType<typeof vi.fn>

    beforeEach(() => {
        logCreatedEvent = vi.fn((_req: unknown, cb: (err: unknown, res: unknown) => void) => cb(null, {}))
        client = new GrpcClient()
        client.binSessionId = 'bin-1'
        client.client = { logCreatedEvent } as any
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    it('forwards the attachment fields on a log entry to the binary', async () => {
        // Attachment entries carry no message — the binary streams the file from
        // filePath, so dropping these three silently breaks attachment upload.
        await client.logCreatedEvent({
            platformIndex: 0,
            logs: [{
                uuid: 'log-1',
                kind: 'TEST_ATTACHMENT',
                timestamp: '2026-01-01T00:00:00Z',
                level: 'info',
                fileName: 'screenshot.png',
                fileSize: 2048,
                filePath: '/tmp/screenshot.png'
            }],
            executionContext: { processId: 1, threadId: 2, hash: 'h' }
        } as any)

        expect(logCreatedEvent).toHaveBeenCalledTimes(1)
        const sent = logCreatedEvent.mock.calls[0][0] as any
        expect(sent.logs[0]).toMatchObject({
            fileName: 'screenshot.png',
            fileSize: 2048,
            filePath: '/tmp/screenshot.png'
        })
    })
})
