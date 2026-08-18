import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as bstackLogger from '../../src/bstackLogger.js'

import { CLIUtils } from '../../src/cli/cliUtils.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

const DOWNLOAD_URL = 'https://sdk-assets.browserstack.com/binary-macos-arm64-1.48.0.zip'

describe('SDK-7233 — binary update must not be skipped for a stale binary', () => {
    let cliDir: string

    beforeEach(() => {
        cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk7233-cli-'))
    })

    afterEach(() => {
        vi.restoreAllMocks()
        fs.rmSync(cliDir, { recursive: true, force: true })
    })

    it('parses the target version out of the download URL', () => {
        expect(CLIUtils.getVersionFromBinaryUrl(DOWNLOAD_URL)).toBe('1.48.0')
        expect(CLIUtils.getVersionFromBinaryUrl('https://x/custom-build.zip')).toBeNull()
    })

    describe('isBinaryAtVersion', () => {
        it('is true only when the binary reports exactly the expected version', async () => {
            vi.spyOn(CLIUtils, 'runShellCommand').mockResolvedValue('1.48.0\n')
            await expect(CLIUtils.isBinaryAtVersion('/bin/bs', '1.48.0')).resolves.toBe(true)
            await expect(CLIUtils.isBinaryAtVersion('/bin/bs', '1.22.1')).resolves.toBe(false)
        })

        it('fails open (false ⇒ download) on a busy or erroring binary', async () => {
            const shell = vi.spyOn(CLIUtils, 'runShellCommand')
            shell.mockResolvedValue('SHELL_EXECUTE_ERROR')
            await expect(CLIUtils.isBinaryAtVersion('/bin/bs', '1.48.0')).resolves.toBe(false)
            shell.mockResolvedValue('text file busy')
            await expect(CLIUtils.isBinaryAtVersion('/bin/bs', '1.48.0')).resolves.toBe(false)
            shell.mockRejectedValue(new Error('spawn failed'))
            await expect(CLIUtils.isBinaryAtVersion('/bin/bs', '1.48.0')).resolves.toBe(false)
        })

        it('returns false when no expected version is known', async () => {
            const shell = vi.spyOn(CLIUtils, 'runShellCommand')
            await expect(CLIUtils.isBinaryAtVersion('/bin/bs', null)).resolves.toBe(false)
            expect(shell).not.toHaveBeenCalled()
        })
    })

    it('uses the server-reported version when the URL carries none (custom BROWSERSTACK_BINARY_URL)', async () => {
        // Without this, a custom binary URL would make targetVersion null, which
        // disables the peer-race short-circuit and re-downloads on every run.
        const peerDownloaded = path.join(cliDir, 'binary-macos-arm64')
        fs.writeFileSync(peerDownloaded, 'fresh-binary-v1.48.0')
        const atVersion = vi.spyOn(CLIUtils, 'isBinaryAtVersion').mockResolvedValue(true)
        const fetchSpy = vi.spyOn(globalThis, 'fetch')

        const returned = await CLIUtils.downloadLatestBinary(
            'https://mirror.internal/custom-build.zip',
            cliDir,
            '1.48.0',
        )

        expect(atVersion).toHaveBeenCalledWith(peerDownloaded, '1.48.0')
        expect(returned).toBe(peerDownloaded)
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('downloads the update when the on-disk binary is a stale version', async () => {
        // downloadLatestBinary is only reached once the server has said an update
        // is required, so a pre-existing binary here is stale by construction.
        fs.writeFileSync(path.join(cliDir, 'binary-macos-arm64'), 'stale-binary-v1.22.1')
        vi.spyOn(CLIUtils, 'isBinaryAtVersion').mockResolvedValue(false)
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockRejectedValue(new Error('network disabled in test'))

        // Now rejects instead of hanging: processDownload() propagates the
        // fetch failure to the caller.
        await expect(
            CLIUtils.downloadLatestBinary(DOWNLOAD_URL, cliDir),
        ).rejects.toThrow('network disabled in test')
        expect(fetchSpy).toHaveBeenCalledWith(DOWNLOAD_URL, expect.anything())
        // let the aborted write stream finish tearing down before afterEach
        // removes the temp dir out from under its pending open()
        await new Promise((r) => setTimeout(r, 50))
    })

    it('skips the download when a peer already fetched the target version', async () => {
        const peerDownloaded = path.join(cliDir, 'binary-macos-arm64')
        fs.writeFileSync(peerDownloaded, 'fresh-binary-v1.48.0')
        vi.spyOn(CLIUtils, 'isBinaryAtVersion').mockResolvedValue(true)
        const fetchSpy = vi.spyOn(globalThis, 'fetch')

        const returned = await CLIUtils.downloadLatestBinary(DOWNLOAD_URL, cliDir)

        expect(returned).toBe(peerDownloaded)
        expect(fetchSpy).not.toHaveBeenCalled()
    })
})
