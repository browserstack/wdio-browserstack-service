import * as FunnelTestEvent from '../../src/instrumentation/funnelInstrumentation.js'
import { sendFinish, sendStart } from '../../src/instrumentation/funnelInstrumentation.js'
import { BStackLogger } from '../../src/bstackLogger.js'
import fs from 'node:fs'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { FUNNEL_INSTRUMENTATION_URL } from '../../src/constants.js'

vi.mock('fetch')
const mockedFetch = vi.mocked(fetch)

const config = {
    userName: 'your-username',
    accessKey: 'your-access-key',
    testObservability: { enabled: true },
    framework: 'framework',
    buildName: 'build-name',
    buildIdentifier: 'your-build-identifier',
    accessibility: true,
    percy: true,
    automate: true,
    appAutomate: false,
}

describe('funnelInstrumentation', () => {
    let originalCwd: { (): string; (): string }

    beforeEach(() => {
        originalCwd = process.cwd
        process.cwd = () => '/path/to/project'
        vi.spyOn(BStackLogger, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
        process.cwd = originalCwd
        vi.restoreAllMocks()
        vi.resetAllMocks()
        vi.clearAllMocks()
    })

    describe('sendStart', () => {
        it('does nothing if userName or accessKey is missing in config', async () => {
            const config = { userName: '', accessKey: '' }
            await FunnelTestEvent.sendStart(config as any)

            expect(fetch).not.toHaveBeenCalled()
        })

        it('sendStart calls sends request with correct data', async () => {
            await sendStart(config as any)

            expect(fetch).toHaveBeenCalledWith(FUNNEL_INSTRUMENTATION_URL, expect.objectContaining({
                method: 'POST',
                headers: expect.any(Object),
                body: expect.any(String) // TODO: find a way to match exact
            }))
        })
    })

    describe('sendFinish', () => {
        it('sendFinish calls sends request with correct data', async () => {
            const finishConfig = {
                ...config,
                'accessibility': false,
                'percy': false,
            }

            await sendFinish(finishConfig as any)
            expect(fetch).toHaveBeenCalledWith(FUNNEL_INSTRUMENTATION_URL, expect.objectContaining({
                method: 'POST',
                headers: expect.any(Object),
                body: expect.any(String) // TODO: find a way to match exact
            }))
        })

        it('includes isCLIEnabled=true in event_properties when explicitly passed', async () => {
            mockedFetch.mockReturnValueOnce(Promise.resolve(Response.json({})))
            await sendFinish(config as any, true)
            const [[, { body }]] = mockedFetch.mock.calls
            const parsedBody = JSON.parse(body as string)
            expect(parsedBody.event_properties.isCLIEnabled).toBe(true)
        })

        it('defaults isCLIEnabled to false in event_properties when not provided', async () => {
            mockedFetch.mockReturnValueOnce(Promise.resolve(Response.json({})))
            await sendFinish(config as any)
            const [[, { body }]] = mockedFetch.mock.calls
            const parsedBody = JSON.parse(body as string)
            expect(parsedBody.event_properties.isCLIEnabled).toBe(false)
        })
    })

    it('saveFunnelData writes data to file and returns file path', () => {
        BStackLogger.ensureLogsFolder = vi.fn()
        vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {})
        const filePath = FunnelTestEvent.saveFunnelData('SDKTestSuccessful', config as any)
        expect(fs.writeFileSync).toHaveBeenCalledWith(filePath, expect.any(String))
    })

    it('saveFunnelData writes isCLIEnabled=true in event_properties when explicitly passed', () => {
        BStackLogger.ensureLogsFolder = vi.fn()
        let writtenData = ''
        vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((_path, data) => { writtenData = data as string })
        FunnelTestEvent.saveFunnelData('SDKTestSuccessful', config as any, true)
        const parsed = JSON.parse(writtenData)
        expect(parsed.event_properties.isCLIEnabled).toBe(true)
    })

    it('saveFunnelData defaults isCLIEnabled to false in event_properties when not provided', () => {
        BStackLogger.ensureLogsFolder = vi.fn()
        let writtenData = ''
        vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((_path, data) => { writtenData = data as string })
        FunnelTestEvent.saveFunnelData('SDKTestSuccessful', config as any)
        const parsed = JSON.parse(writtenData)
        expect(parsed.event_properties.isCLIEnabled).toBe(false)
    })

    it('fireFunnelRequest sends request with correct data', async () => {
        const data = { key: 'value', userName: '[REDACTED]', accessKey: '[REDACTED]' }
        mockedFetch.mockReturnValueOnce(Promise.resolve(Response.json({})))
        await FunnelTestEvent.fireFunnelRequest(data)
        expect(fetch).toHaveBeenCalledWith(FUNNEL_INSTRUMENTATION_URL, expect.objectContaining({
            method: 'POST',
            headers: expect.any(Object),
            body: JSON.stringify(data)
        }))
    })
})
