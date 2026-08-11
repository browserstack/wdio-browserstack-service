import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { list } from 'tar'

import { uploadLogs } from '../src/util.js'
import { BStackLogger } from '../src/bstackLogger.js'
import { BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS, BROWSERSTACK_WDIO_CONFIG_FILE_PATH } from '../src/constants.js'
import { _fetch as fetch } from '../src/fetchWrapper.js'

vi.mock('../src/fetchWrapper.js', () => ({ _fetch: vi.fn() }))
vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))

/** the gzipped tarball actually handed to the upload endpoint */
let uploadedArchive: Buffer | undefined
let tmpProject: string
let cwdSpy: ReturnType<typeof vi.spyOn>
let originalLogFilePath: string

const readArchiveEntries = async (gz: Buffer) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-untar-'))
    const tarPath = path.join(workDir, 'logs.tar')
    fs.writeFileSync(tarPath, zlib.gunzipSync(gz))

    const entries: string[] = []
    await list({ file: tarPath, onentry: (e) => entries.push(String(e.path)) })
    fs.rmSync(workDir, { recursive: true, force: true })
    return entries
}

beforeEach(() => {
    uploadedArchive = undefined
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-upload-test-'))
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpProject)
    originalLogFilePath = BStackLogger.logFilePath
    BStackLogger.logFilePath = path.join(tmpProject, 'bstack-wdio-service.log')
    fs.writeFileSync(BStackLogger.logFilePath, 'service log content')
    delete process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH]
    delete process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS]

    vi.mocked(fetch).mockImplementation((async (_url: string, init: RequestInit) => {
        // read the archive here: uploadLogs removes its staging dir right after
        const body = init?.body as FormData
        const blob = body?.get?.('data') as Blob | null
        if (blob && typeof blob.arrayBuffer === 'function') {
            uploadedArchive = Buffer.from(await blob.arrayBuffer())
        }
        return Response.json({ status: 'success' })
    }) as never)
})

afterEach(() => {
    cwdSpy.mockRestore()
    BStackLogger.logFilePath = originalLogFilePath
    delete process.env[BROWSERSTACK_WDIO_CONFIG_FILE_PATH]
    delete process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS]
    fs.rmSync(tmpProject, { recursive: true, force: true })
    vi.mocked(fetch).mockReset()
})

describe('uploadLogs archive contents (SDK-7250)', () => {
    it('ships the wdio config, its local import and package.json alongside the service log', async () => {
        fs.writeFileSync(path.join(tmpProject, 'package.json'), '{"name":"customer-app","version":"1.2.3"}')
        fs.writeFileSync(path.join(tmpProject, 'shared.conf.js'), 'export const shared = { maxInstances: 7 }')
        fs.writeFileSync(path.join(tmpProject, 'wdio.conf.js'), [
            'import { shared } from "./shared.conf.js"',
            'export const config = {',
            '    ...shared,',
            "    user: 'LEAKED_USER_VALUE',",
            "    key: 'LEAKED_KEY_VALUE',",
            '    services: [["browserstack", { accessibility: true }]]',
            '}'
        ].join('\n'))

        await uploadLogs('some_user', 'some_key', 'some_uuid', {})

        expect(fetch).toHaveBeenCalled()
        expect(uploadedArchive).toBeDefined()

        const entries = await readArchiveEntries(uploadedArchive!)
        expect(entries).toContain('wdio.conf.js')
        expect(entries).toContain('shared.conf.js')
        expect(entries).toContain('package.json')
        expect(entries).toContain('bstack-wdio-service.log')
    })

    it('redacts package.json instead of archiving it verbatim (PR review, SDK-7250)', async () => {
        fs.writeFileSync(path.join(tmpProject, 'package.json'), JSON.stringify({
            name: 'customer-app',
            version: '1.2.3',
            scripts: { deploy: 'gh release upload --token=ghp_LEAKED_IN_MANIFEST' },
            dependencies: { webdriverio: '^9.0.0' }
        }, null, 2))
        fs.writeFileSync(path.join(tmpProject, 'wdio.conf.js'), 'export const config = {}')

        await uploadLogs('some_user', 'some_key', 'some_uuid', {})

        const raw = zlib.gunzipSync(uploadedArchive!).toString('binary')
        expect(raw).not.toContain('ghp_LEAKED_IN_MANIFEST')
        // the reason we ship it at all must survive the scrub
        expect(raw).toContain('webdriverio')
        expect(raw).toContain('1.2.3')
        expect(await readArchiveEntries(uploadedArchive!)).toContain('package.json')
    })

    it('scrubs credentials out of the archived config', async () => {
        fs.writeFileSync(path.join(tmpProject, 'wdio.conf.js'), [
            'export const config = {',
            "    user: 'LEAKED_USER_VALUE',",
            "    key: 'LEAKED_KEY_VALUE',",
            '    services: [["browserstack", { accessibility: true }]]',
            '}'
        ].join('\n'))

        await uploadLogs('some_user', 'some_key', 'some_uuid', {})

        const raw = zlib.gunzipSync(uploadedArchive!).toString('binary')
        expect(raw).not.toContain('LEAKED_USER_VALUE')
        expect(raw).not.toContain('LEAKED_KEY_VALUE')
        // non-credential config must survive, else the artifact is useless for triage
        expect(raw).toContain('accessibility: true')
    })

    it('still uploads the logs when no config can be found', async () => {
        await uploadLogs('some_user', 'some_key', 'some_uuid', {})

        expect(fetch).toHaveBeenCalled()
        const entries = await readArchiveEntries(uploadedArchive!)
        expect(entries).toContain('bstack-wdio-service.log')
        expect(entries).not.toContain('wdio.conf.js')
    })

    it('uploads nothing when disableAutoCaptureLogs is set', async () => {
        fs.writeFileSync(path.join(tmpProject, 'wdio.conf.js'), 'export const config = {}')

        await uploadLogs('some_user', 'some_key', 'some_uuid', { disableAutoCaptureLogs: true })

        expect(fetch).not.toHaveBeenCalled()
    })

    it('honours the opt-out env var when called with no options (cleanup process)', async () => {
        // The detached cleanup rescue calls uploadLogs(user, key, uuid) with NO options.
        // Before the fix it uploaded the config of every user who had opted out, because
        // opting out leaves `logsUploaded` false, which is what arms the rescue.
        fs.writeFileSync(path.join(tmpProject, 'wdio.conf.js'), 'export const config = {}')
        process.env[BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS] = 'true'

        await uploadLogs('some_user', 'some_key', 'some_uuid')

        expect(fetch).not.toHaveBeenCalled()
    })

    it('leaves no staging directory behind', async () => {
        fs.writeFileSync(path.join(tmpProject, 'wdio.conf.js'), 'export const config = {}')
        const before = fs.readdirSync(os.tmpdir()).filter((e) => e.startsWith('bstack-wdio-logs-'))

        await uploadLogs('some_user', 'some_key', 'some_uuid', {})

        const after = fs.readdirSync(os.tmpdir()).filter((e) => e.startsWith('bstack-wdio-logs-'))
        expect(after).toEqual(before)
    })

    it('keeps concurrent runs from clobbering each other', async () => {
        fs.writeFileSync(path.join(tmpProject, 'wdio.conf.js'), 'export const config = {}')

        const results = await Promise.all([
            uploadLogs('some_user', 'some_key', 'uuid-1', {}),
            uploadLogs('some_user', 'some_key', 'uuid-2', {}),
            uploadLogs('some_user', 'some_key', 'uuid-3', {})
        ])

        expect(results.every((r) => r && r.status === 'success')).toBe(true)
        expect(fetch).toHaveBeenCalledTimes(3)
    })
})
