import * as utils from '../src/util.js'
import BStackCleanup from '../src/cleanup.js'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import * as FunnelTestEvent from '../src/instrumentation/funnelInstrumentation.js'
import * as bstackLogger from '../src/bstackLogger.js'
import { BROWSERSTACK_TESTHUB_JWT } from '../src/constants.js'

const bstackLoggerSpy = vi.spyOn(bstackLogger.BStackLogger, 'logToFile')
bstackLoggerSpy.mockImplementation(() => {})

describe('BStackCleanup', () => {
    let originalArgv
    let originalEnv

    beforeEach(() => {
        originalArgv = process.argv
        originalEnv = process.env
        process.argv = []
        process.env = {}
    })

    afterEach(() => {
        process.argv = originalArgv
        process.env = originalEnv
        vi.resetAllMocks()
        vi.restoreAllMocks()
    })

    describe('startCleanup', () => {
        it('executes observability cleanup if --observability is present in argv', async () => {
            vi.spyOn(utils, 'stopBuildUpstream')
            process.argv.push('--observability')
            process.env[BROWSERSTACK_TESTHUB_JWT] = 'some jwt'

            await BStackCleanup.startCleanup()

            expect(utils.stopBuildUpstream).toHaveBeenCalledTimes(1)
        })

        it('gets data and removes funnel data file', async () => {
            const filePath = 'some_file.json'
            process.argv.push('--funnelData', filePath)
            vi.spyOn(fs, 'readFileSync').mockReturnValue('{"data": 123}')
            vi.spyOn(fs, 'rmSync')
            vi.spyOn(FunnelTestEvent, 'fireFunnelRequest').mockResolvedValueOnce()

            await BStackCleanup.startCleanup()
            expect(fs.readFileSync).toHaveBeenNthCalledWith(1, filePath, 'utf8')
            expect(fs.rmSync).toHaveBeenNthCalledWith(1, filePath, expect.any(Object))
            expect(FunnelTestEvent.fireFunnelRequest).toHaveBeenCalled()
        })

        it('uploads logs with the credentials snapshotted before funnel redaction', async () => {
            const filePath = 'some_file.json'
            process.argv.push('--funnelData', filePath, '--uploadLogs', 'build-uuid-1')
            vi.spyOn(fs, 'readFileSync').mockReturnValue('{"userName": "snapUser", "accessKey": "snapKey"}')
            vi.spyOn(fs, 'rmSync')
            const uploadLogsSpy = vi.spyOn(utils, 'uploadLogs').mockResolvedValueOnce('ok')
            // fireFunnelRequest redacts the credentials on the funnel object in place.
            vi.spyOn(FunnelTestEvent, 'fireFunnelRequest').mockImplementationOnce(async (data: any) => {
                data.userName = 'REDACTED'
                data.accessKey = 'REDACTED'
            })

            await BStackCleanup.startCleanup()

            expect(uploadLogsSpy).toHaveBeenCalledWith('snapUser', 'snapKey', 'build-uuid-1')
        })

        it('does not upload logs when --uploadLogs is absent', async () => {
            const uploadLogsSpy = vi.spyOn(utils, 'uploadLogs')
            await BStackCleanup.startCleanup()
            expect(uploadLogsSpy).not.toHaveBeenCalled()
        })
    })

    describe('executeLogsUpload', () => {
        it('uploads logs with the funnel credentials and the --uploadLogs uuid', async () => {
            process.argv.push('--uploadLogs', 'build-uuid-2')
            const uploadLogsSpy = vi.spyOn(utils, 'uploadLogs').mockResolvedValueOnce('ok')

            await BStackCleanup.executeLogsUpload('funnelUser', 'funnelKey')

            expect(uploadLogsSpy).toHaveBeenCalledWith('funnelUser', 'funnelKey', 'build-uuid-2')
        })

        it('falls back to env credentials when funnel credentials are absent', async () => {
            process.argv.push('--uploadLogs', 'build-uuid-3')
            process.env.BROWSERSTACK_USERNAME = 'envUser'
            process.env.BROWSERSTACK_ACCESS_KEY = 'envKey'
            const uploadLogsSpy = vi.spyOn(utils, 'uploadLogs').mockResolvedValueOnce('ok')

            await BStackCleanup.executeLogsUpload()

            expect(uploadLogsSpy).toHaveBeenCalledWith('envUser', 'envKey', 'build-uuid-3')
        })

        it('skips upload when credentials are missing', async () => {
            process.argv.push('--uploadLogs', 'build-uuid-4')
            const uploadLogsSpy = vi.spyOn(utils, 'uploadLogs')

            await BStackCleanup.executeLogsUpload()

            expect(uploadLogsSpy).not.toHaveBeenCalled()
        })

        it('skips upload when the uuid is missing', async () => {
            const uploadLogsSpy = vi.spyOn(utils, 'uploadLogs')

            await BStackCleanup.executeLogsUpload('funnelUser', 'funnelKey')

            expect(uploadLogsSpy).not.toHaveBeenCalled()
        })
    })

    describe('executeObservabilityCleanup', () => {
        const stopBuildUpstreamSpy = vi.spyOn(utils, 'stopBuildUpstream')

        it('does not invoke stop call for observability when jwt is not set', async () => {
            await BStackCleanup.executeObservabilityCleanup({})
            expect(stopBuildUpstreamSpy).toBeCalledTimes(0)
        })

        it('invoke stop call for observability when jwt is set', async () => {
            process.env[BROWSERSTACK_TESTHUB_JWT] = 'jwtToken'
            await BStackCleanup.executeObservabilityCleanup({})
            expect(stopBuildUpstreamSpy).toBeCalledTimes(1)
        })
    })

    describe('sendFunnelData', () => {
        it('sends funnel data and removes file', async () => {
            const funnelData = { key: 'value' }
            vi.spyOn(FunnelTestEvent, 'fireFunnelRequest').mockResolvedValueOnce()
            await BStackCleanup.sendFunnelData(funnelData)
            expect(FunnelTestEvent.fireFunnelRequest).toHaveBeenCalledWith(funnelData)
        })
    })

    describe('removeFunnelDataFile', () => {
        it('removes file if filePath is provided', () => {
            vi.spyOn(fs, 'rmSync')
            BStackCleanup.removeFunnelDataFile('test-file-path')
            expect(fs.rmSync).toHaveBeenCalledWith('test-file-path', { force: true })
        })

        it('does nothing if filePath is not provided', () => {
            vi.spyOn(fs, 'rmSync')
            BStackCleanup.removeFunnelDataFile()
            expect(fs.rmSync).not.toHaveBeenCalled()
        })
    })
})

