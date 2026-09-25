import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { GrpcClient } from '../../src/cli/grpcClient.js'
import * as bstackLogger from '../../src/bstackLogger.js'
import { BStackLogger as CliBStackLogger } from '../../src/cli/cliLogger.js'
import type { SDKClient } from '../../src/grpc/index.js'
import { CLIUtils } from '../../src/cli/cliUtils.js'
import type grpc from '@grpc/grpc-js'

const bstackLoggerSpy = vi.spyOn(bstackLogger.BStackLogger, 'logToFile')
bstackLoggerSpy.mockImplementation(() => {})

describe('GrpcClient', () => {
    let grpcClient: GrpcClient
    beforeEach(() => {
        vi.resetAllMocks()
        grpcClient = GrpcClient.getInstance()
    })

    afterEach(() => {
        vi.resetAllMocks()
        vi.restoreAllMocks()
    })

    describe('getClient()', () => {
        it('should return null when client is not initialized', () => {
            expect(grpcClient.getClient()).toBe(null)
        })

        it('should return SDKClient instance when client is initialized', () => {
            const mockClient = {} as SDKClient
            grpcClient.client = mockClient

            expect(grpcClient.getClient()).toEqual(mockClient)
        })
    })

    describe('getChannel()', () => {
        it('should return null when channel is not initialized', () => {
            expect(grpcClient.getChannel()).toBe(null)
        })

        it('should return grpc.Channel instance when channel is initialized', () => {
            const mockChannel = {} as grpc.Channel
            grpcClient.channel = mockChannel

            expect(grpcClient.getChannel()).toEqual(mockChannel)
        })
    })

    describe('startBinSession', () => {
        beforeEach(() => {
            vi.resetAllMocks()

            vi.spyOn(CLIUtils, 'getSdkVersion').mockReturnValue('1.0.0')
            vi.spyOn(CLIUtils, 'getAutomationFrameworkDetail').mockReturnValue({
                name: 'webdriver',
                version: {}
            })
            vi.spyOn(CLIUtils, 'getTestFrameworkDetail').mockReturnValue({
                name: '',
                version: {}
            })
            vi.spyOn(CLIUtils, 'getSdkLanguage').mockReturnValue('typescript')

            grpcClient = new GrpcClient()
            grpcClient.binSessionId = 'test-session-id'
        })

        it('successfully starts bin session', async () => {
            const mockResponse = { status: 'success' }
            const mockStartBinSession = vi.fn().mockImplementation((req, cb) => cb(null, mockResponse))
            grpcClient.client = { startBinSession: mockStartBinSession } as any

            const response = await grpcClient.startBinSession('test-config')

            expect(response).toEqual(mockResponse)
            expect(mockStartBinSession).toHaveBeenCalledWith(
                expect.objectContaining({
                    binSessionId: 'test-session-id',
                    sdkVersion: '1.0.0',
                    testFramework: '',
                    wdioConfig: 'test-config',
                    sdkLanguage: 'typescript',
                    language: 'typescript',
                    frameworks: ['webdriver', ''],
                    frameworkVersions: {}
                }),
                expect.any(Function)
            )
        })

        it('throws error when client is not initialized', async () => {
            grpcClient.client = null

            await expect(grpcClient.startBinSession('test-config'))
                .rejects
                .toThrow()
        })

        it('handles gRPC call errors', async () => {
            const mockError = new Error('Start session failed')
            const mockStartBinSession = vi.fn().mockImplementation((req, cb) => cb(mockError))
            grpcClient.client = { startBinSession: mockStartBinSession } as any

            await expect(grpcClient.startBinSession('test-config'))
                .rejects
                .toThrow('Start session failed')
        })
    })

    describe('stopBinSession', () => {
        beforeEach(() => {
            vi.resetAllMocks()

            grpcClient = new GrpcClient()
            grpcClient.binSessionId = 'test-session-id'
        })
        it('successfully stops bin session', async () => {
            const mockResponse = { status: 'success' }
            const mockStopBinSession = vi.fn().mockImplementation((req, cb) => cb(null, mockResponse))
            grpcClient.client = { stopBinSession: mockStopBinSession } as any

            const response = await grpcClient.stopBinSession()

            expect(response).toEqual(mockResponse)
        })

        it('throws error when binSessionId is missing', async () => {
            grpcClient.binSessionId = undefined

            await expect(grpcClient.stopBinSession()).resolves.toBeUndefined()
        })

        it('stamps exitSignal and user_killed reason when the kill-signal env is set', async () => {
            process.env.BROWSERSTACK_SDK_KILL_SIGNAL = 'SIGINT'
            const mockStopBinSession = vi.fn().mockImplementation((req, cb) => cb(null, {}))
            grpcClient.client = { stopBinSession: mockStopBinSession } as any

            await grpcClient.stopBinSession()

            const request = mockStopBinSession.mock.calls[0][0]
            expect(request.exitSignal).toBe('SIGINT')
            expect(request.exitReason).toBe('user_killed')
            delete process.env.BROWSERSTACK_SDK_KILL_SIGNAL
        })

        it('omits exit metadata when the kill-signal env is unset', async () => {
            delete process.env.BROWSERSTACK_SDK_KILL_SIGNAL
            const mockStopBinSession = vi.fn().mockImplementation((req, cb) => cb(null, {}))
            grpcClient.client = { stopBinSession: mockStopBinSession } as any

            await grpcClient.stopBinSession()

            const request = mockStopBinSession.mock.calls[0][0]
            expect(request.exitSignal).toBe('')
            expect(request.exitReason).toBe('')
        })

        describe('customer-visible summary entries', () => {
            let stdoutSpy: ReturnType<typeof vi.spyOn>
            let stderrSpy: ReturnType<typeof vi.spyOn>

            const respondWith = (response: unknown) => {
                grpcClient.client = {
                    stopBinSession: vi.fn().mockImplementation((req, cb) => cb(null, response))
                } as any
            }

            beforeEach(() => {
                stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
                stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
            })

            afterEach(() => {
                stdoutSpy.mockRestore()
                stderrSpy.mockRestore()
            })

            it('writes the body verbatim to stdout for an info entry', async () => {
                respondWith({ entries: [{ entryType: 'version_nudge', severity: 'info', body: 'line one\nline two' }] })
                await grpcClient.stopBinSession()
                expect(stdoutSpy).toHaveBeenCalledWith('line one\nline two\n')
                expect(stderrSpy).not.toHaveBeenCalled()
            })

            it('routes warn and error entries to stderr', async () => {
                respondWith({ entries: [
                    { entryType: 'version_nudge', severity: 'warn', body: 'outdated' },
                    { entryType: 'version_nudge', severity: 'error', body: 'deprecated' }
                ] })
                await grpcClient.stopBinSession()
                expect(stderrSpy).toHaveBeenCalledWith('\x1b[1;33moutdated\x1b[0m\n')
                expect(stderrSpy).toHaveBeenCalledWith('\x1b[1;31mdeprecated\x1b[0m\n')
                expect(stdoutSpy).not.toHaveBeenCalled()
            })

            it('treats the server\'s "warning" spelling as an error stream', async () => {
                respondWith({ entries: [{ entryType: 'version_nudge', severity: 'warning', body: 'outdated' }] })
                await grpcClient.stopBinSession()
                expect(stderrSpy).toHaveBeenCalledWith('\x1b[1;33moutdated\x1b[0m\n')
            })

            it('tints a warn block yellow and an error block red, line by line', async () => {
                const body = '────\n  Title\n\n  Detail\n────'
                respondWith({ entries: [
                    { entryType: 'version_nudge', severity: 'warn', body },
                    { entryType: 'version_nudge', severity: 'error', body }
                ] })
                await grpcClient.stopBinSession()

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
                await grpcClient.stopBinSession()
                expect(stdoutSpy).toHaveBeenCalledWith('body\n')
                expect(stderrSpy).not.toHaveBeenCalled()
            })

            it('writes nothing when entries are absent, empty, or bodiless', async () => {
                for (const response of [{ done: true }, { entries: [] }, { entries: [{ severity: 'warn', body: '' }] }]) {
                    respondWith(response)
                    await grpcClient.stopBinSession()
                }
                expect(stdoutSpy).not.toHaveBeenCalled()
                expect(stderrSpy).not.toHaveBeenCalled()
            })

            it('archives via logToFile only, so the block is never printed twice', async () => {
                // logToFile writes to the log file only. info/warn/error additionally
                // call @wdio/logger, which writes to the console — using them here
                // would duplicate the block the stream writes above already emitted.
                const toFile = vi.spyOn(CliBStackLogger, 'logToFile').mockImplementation(() => {})
                const infoSpy = vi.spyOn(CliBStackLogger, 'info').mockImplementation(() => {})
                const warnSpy = vi.spyOn(CliBStackLogger, 'warn').mockImplementation(() => {})
                const errorSpy = vi.spyOn(CliBStackLogger, 'error').mockImplementation(() => {})

                respondWith({ entries: [
                    { entryType: 'version_nudge', severity: 'warning', body: 'outdated' },
                    { entryType: 'version_nudge', severity: 'error', body: 'deprecated' },
                    { entryType: 'version_nudge', severity: 'info', body: 'notice' }
                ] })
                await grpcClient.stopBinSession()

                expect(toFile).toHaveBeenCalledWith('outdated', 'warn')
                expect(toFile).toHaveBeenCalledWith('deprecated', 'error')
                expect(toFile).toHaveBeenCalledWith('notice', 'info')
                // The console-writing helpers must never receive a body. (They are
                // still used for unrelated lines such as "StopBinSession successful".)
                for (const body of ['outdated', 'deprecated', 'notice']) {
                    expect(warnSpy).not.toHaveBeenCalledWith(body)
                    expect(errorSpy).not.toHaveBeenCalledWith(body)
                    expect(infoSpy).not.toHaveBeenCalledWith(body)
                }

                toFile.mockRestore()
                infoSpy.mockRestore()
                warnSpy.mockRestore()
                errorSpy.mockRestore()
            })

            it('keeps rendering and archiving the entries after one whose write throws', async () => {
                // The catch is scoped per entry, not around the loop: a stream that
                // rejects entry one must not silently drop entries two and three.
                const toFile = vi.spyOn(CliBStackLogger, 'logToFile').mockImplementation(() => {})
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
                await grpcClient.stopBinSession()

                expect(stderrSpy).toHaveBeenCalledWith('\x1b[1;33msecond\x1b[0m\n')
                expect(stdoutSpy).toHaveBeenCalledWith('third\n')
                // Archival runs before the stream write, so even the entry whose
                // write threw is still kept in the log directory.
                expect(toFile).toHaveBeenCalledWith('first', 'warn')
                expect(toFile).toHaveBeenCalledWith('second', 'warn')
                expect(toFile).toHaveBeenCalledWith('third', 'info')

                toFile.mockRestore()
            })

            it('still returns the response when rendering throws', async () => {
                stdoutSpy.mockImplementation(() => {
                    throw new Error('stream closed')
                })
                respondWith({ entries: [{ severity: 'info', body: 'body' }], done: true })
                await expect(grpcClient.stopBinSession()).resolves.toMatchObject({ done: true })
            })
        })
    })

    describe('connectBinSession', () => {
        beforeEach(() => {
            vi.resetAllMocks()

            grpcClient = new GrpcClient()
            grpcClient.binSessionId = 'test-session-id'
        })

        it('successfully connects to bin session', async () => {
            const mockResponse = { status: 'connected' }
            const mockConnectBinSession = vi.fn().mockImplementation((req, cb) => cb(null, mockResponse))
            grpcClient.client = { connectBinSession: mockConnectBinSession } as any

            const response = await grpcClient.connectBinSession()

            expect(response).toEqual(mockResponse)
        })

        it('throws error when client is not initialized', async () => {
            grpcClient.client = null

            await expect(grpcClient.connectBinSession())
                .rejects
                .toThrow()
        })

        it('handles gRPC call errors', async () => {
            const mockError = new Error('Connection failed')
            const mockConnectBinSession = vi.fn().mockImplementation((req, cb) => cb(mockError))
            grpcClient.client = { connectBinSession: mockConnectBinSession } as any

            await expect(grpcClient.connectBinSession())
                .rejects
                .toThrow('Connection failed')
        })
    })

})
