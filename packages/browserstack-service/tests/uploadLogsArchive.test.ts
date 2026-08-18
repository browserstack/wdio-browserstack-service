import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { list } from 'tar'

const fsMkdtempOriginal = fs.mkdtempSync

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
let originalLogFolderPath: string

const readArchiveEntry = async (gz: Buffer, entryName: string): Promise<string> => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-untar-one-'))
    const tarPath = path.join(workDir, 'logs.tar')
    fs.writeFileSync(tarPath, zlib.gunzipSync(gz))

    let content = ''
    await list({
        file: tarPath,
        onentry: (e) => {
            if (String(e.path) !== entryName) {
                return
            }
            e.on('data', (chunk: Buffer) => { content += chunk.toString('utf8') })
        }
    })
    fs.rmSync(workDir, { recursive: true, force: true })
    return content
}

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
    originalLogFolderPath = BStackLogger.logFolderPath
    // BStackLogger caches its WriteStream on a static; drop it so it reopens at THIS test's
    // path. Without this the stream still points at the previous test's (deleted) directory.
    BStackLogger.clearLogger()
    BStackLogger.logFolderPath = tmpProject
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
    BStackLogger.clearLogger()
    BStackLogger.logFilePath = originalLogFilePath
    BStackLogger.logFolderPath = originalLogFolderPath
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

    it('puts the capture summary inside the ARCHIVED log, not just the local one', async () => {
        // Two separate regressions are pinned here, both found against a real downloaded
        // bundle. (1) The log is snapshotted LAST, so the resolution strategy and captured
        // names are inside the copy that ships -- copying earlier left them local-only.
        // (2) BStackLogger writes through an async WriteStream, so ordering alone still
        // shipped a truncated log; uploadLogs must flush before it copies.
        fs.writeFileSync(path.join(tmpProject, 'package.json'), '{"name":"app"}')
        fs.writeFileSync(path.join(tmpProject, 'wdio.conf.js'), 'export const config = {}')
        await uploadLogs('some_user', 'some_key', 'some_uuid', {})

        const archivedLog = await readArchiveEntry(uploadedArchive!, 'bstack-wdio-service.log')
        expect(archivedLog).toContain('Auto-captured 1 config file(s) via cwd_default')
        expect(archivedLog).toContain('wdio.conf.js')
        expect(archivedLog).toContain('Auto-captured package.json from')
        // The trailing "archive entries" line lists what actually landed, so it can only be
        // written after the copy -- the log file is itself one of those entries. It stays
        // local-only on purpose; whoever holds the bundle can just list the tarball.
    })

    it('records in the ARCHIVED log when no config was found', async () => {
        await uploadLogs('some_user', 'some_key', 'some_uuid', {})

        const archivedLog = await readArchiveEntry(uploadedArchive!, 'bstack-wdio-service.log')
        expect(archivedLog).toContain('No wdio config captured')
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
        // Spy on the creation rather than diffing os.tmpdir(): vitest runs test FILES in
        // parallel workers and util.test.ts also calls uploadLogs, so a listing-based check
        // races against staging dirs another worker is creating and removing.
        fs.writeFileSync(path.join(tmpProject, 'wdio.conf.js'), 'export const config = {}')
        const created: string[] = []
        const mkdtempSpy = vi.spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string) => {
            const dir = fsMkdtempOriginal(prefix) as string
            created.push(dir)
            return dir
        }) as never)

        await uploadLogs('some_user', 'some_key', 'some_uuid', {})
        mkdtempSpy.mockRestore()

        expect(created.length).toBeGreaterThan(0)
        for (const dir of created) {
            expect(fs.existsSync(dir)).toBe(false)
        }
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

describe('BStackLogger.flushLogFile', () => {
    // Lives here rather than in bstackLogger.test.ts, which mocks node:fs wholesale --
    // buffering is the behaviour under test, so it needs a real stream and a real file.
    let dir: string
    let originalPath: string
    let originalFolder: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-flush-'))
        originalPath = BStackLogger.logFilePath
        originalFolder = BStackLogger.logFolderPath
        BStackLogger.clearLogger()
        BStackLogger.logFolderPath = dir
        BStackLogger.logFilePath = path.join(dir, 'bstack-wdio-service.log')
    })

    afterEach(() => {
        BStackLogger.clearLogger()
        BStackLogger.logFilePath = originalPath
        BStackLogger.logFolderPath = originalFolder
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('puts a just-logged line on disk, which an unflushed write does not', () => {
        BStackLogger.debug('LINE_BEFORE_FLUSH')
        // Baseline: without the flush the stream has not even opened the file yet, so anything
        // that snapshots the log at this instant ships a truncated copy (or none at all).
        const beforeFlush = fs.existsSync(BStackLogger.logFilePath)
            ? fs.readFileSync(BStackLogger.logFilePath, 'utf8')
            : ''
        expect(beforeFlush).not.toContain('LINE_BEFORE_FLUSH')
    })

    it('drains the buffer without ending the stream', async () => {
        BStackLogger.debug('FIRST_LINE')
        await BStackLogger.flushLogFile()
        expect(fs.readFileSync(BStackLogger.logFilePath, 'utf8')).toContain('FIRST_LINE')

        // still writable afterwards -- unlike clearLogger(), which ends the stream
        BStackLogger.debug('SECOND_LINE')
        await BStackLogger.flushLogFile()
        expect(fs.readFileSync(BStackLogger.logFilePath, 'utf8')).toContain('SECOND_LINE')
    })

    it('resolves without a stream open, and cannot hang the upload', async () => {
        BStackLogger.clearLogger()
        await expect(BStackLogger.flushLogFile()).resolves.toBeUndefined()

        // a stream that never invokes the write callback must still resolve, via the timeout
        BStackLogger.debug('x')
        const stuck = { writable: true, write: vi.fn(), end: vi.fn() } as unknown as typeof BStackLogger['logFileStream']
        // @ts-expect-error -- reaching into the private static is the point of the test
        BStackLogger.logFileStream = stuck
        await expect(BStackLogger.flushLogFile(50)).resolves.toBeUndefined()
        // @ts-expect-error -- drop the fake so afterEach does not call end() on it
        BStackLogger.logFileStream = null
    })
})
