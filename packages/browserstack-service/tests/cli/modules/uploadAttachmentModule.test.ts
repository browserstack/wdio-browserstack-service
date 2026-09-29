import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../src/cli/frameworks/testFramework.js', () => ({
    default: class MockTestFramework {
        static registerObserver = vi.fn()
        static getTrackedInstance = vi.fn()
        static getState = vi.fn()
    }
}))

vi.mock('../../../src/cli/frameworks/automationFramework.js', () => ({
    default: class MockAutomationFramework {
        static registerObserver = vi.fn()
        static getTrackedInstance = vi.fn()
        static getDriver = vi.fn()
        static getState = vi.fn()
    }
}))

const logCreatedEvent = vi.fn().mockResolvedValue({ success: true })
vi.mock('../../../src/cli/grpcClient.js', () => ({
    GrpcClient: {
        getInstance: vi.fn(() => ({ logCreatedEvent }))
    }
}))

import UploadAttachmentModule from '../../../src/cli/modules/uploadAttachmentModule.js'
import TestFramework from '../../../src/cli/frameworks/testFramework.js'
import AutomationFramework from '../../../src/cli/frameworks/automationFramework.js'
import WdioMochaTestFramework from '../../../src/cli/frameworks/wdioMochaTestFramework.js'
import { TestFrameworkConstants } from '../../../src/cli/frameworks/constants/testFrameworkConstants.js'
import { UPLOAD_ATTACHMENT_ACK_TIMEOUT_MS } from '../../../src/constants.js'
import { BStackLogger } from '../../../src/cli/cliLogger.js'
import { CLIUtils } from '../../../src/cli/cliUtils.js'

const TEST_UUID = 'test-uuid-1'
const HOOK_UUID = 'hook-uuid-1'

function makeInstance(testState: string) {
    const data = new Map<string, unknown>([
        [TestFrameworkConstants.KEY_TEST_UUID, TEST_UUID],
        [TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME, 'webdriverio-mocha'],
        [TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION, '8.0.0']
    ])
    return {
        getAllData: () => data,
        getCurrentTestState: () => ({ toString: () => `TestFrameworkState.${testState}` }),
        getContext: () => ({
            getId: () => 'ctx-1',
            getThreadId: () => 1,
            getProcessId: () => 2
        })
    }
}

describe('UploadAttachmentModule', () => {
    let attachmentPath: string
    let tmpDir: string
    let writableDir: string
    const snapshotOf = (level: string, name = 'media.txt') => path.join(writableDir, 'UploadedAttachments-0', level, name)
    let browser: Record<string, unknown>

    beforeEach(() => {
        vi.clearAllMocks()
        // afterEach's restoreAllMocks drops the implementation too, so re-arm it here —
        // otherwise every test after the first gets a non-promise back from the ack.
        logCreatedEvent.mockResolvedValue({ success: true })
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-attachment-test-'))
        attachmentPath = path.join(tmpDir, 'media.txt')
        fs.writeFileSync(attachmentPath, 'hello')
        writableDir = path.join(tmpDir, 'writable')
        vi.spyOn(CLIUtils, 'getWritableDir').mockReturnValue(writableDir)

        browser = {}
        vi.mocked(AutomationFramework.getTrackedInstance).mockReturnValue({} as never)
        vi.mocked(AutomationFramework.getDriver).mockReturnValue(browser)
        vi.mocked(TestFramework.getTrackedInstance).mockReturnValue(makeInstance('TEST') as never)
        vi.mocked(TestFramework.getState).mockImplementation((instance, key) => instance.getAllData().get(key))
    })

    afterEach(() => {
        // fs.statSync / lastActiveHook are spied per-test; without this they leak and the
        // next test passes for the wrong reason.
        vi.restoreAllMocks()
        vi.useRealTimers()
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    async function register() {
        const module = new UploadAttachmentModule()
        await module.onBeforeExecute()
        return module
    }

    it('registers uploadAttachment and the uploadMedia alias on the browser', async () => {
        await register()
        expect(typeof browser.uploadAttachment).toBe('function')
        expect(typeof browser.uploadMedia).toBe('function')
        expect(browser.uploadMedia).toBe(browser.uploadAttachment)
    })

    it('sends a TestLevel TEST_ATTACHMENT log entry keyed on the test uuid', async () => {
        await register()
        await (browser.uploadMedia as (p: string) => Promise<void>)(attachmentPath)

        expect(logCreatedEvent).toHaveBeenCalledTimes(1)
        const [log] = logCreatedEvent.mock.calls[0][0].logs
        expect(log).toMatchObject({
            kind: 'TEST_ATTACHMENT',
            level: 'TestLevel',
            uuid: TEST_UUID,
            fileName: 'media.txt',
            fileSize: 5,
            filePath: snapshotOf('TestLevel')
        })
    })

    it('attributes the attachment to the active hook when inside one', async () => {
        vi.spyOn(WdioMochaTestFramework, 'lastActiveHook').mockReturnValue({
            [TestFrameworkConstants.KEY_HOOK_ID]: HOOK_UUID
        })
        vi.mocked(TestFramework.getTrackedInstance).mockReturnValue(makeInstance('BEFORE_ALL') as never)

        await register()
        await (browser.uploadAttachment as (p: string) => Promise<void>)(attachmentPath)

        const [log] = logCreatedEvent.mock.calls[0][0].logs
        expect(log.level).toBe('HookLevel')
        expect(log.uuid).toBe(HOOK_UUID)
    })

    it('marks the entry BuildLevel when buildAttachment is set', async () => {
        await register()
        await (browser.uploadAttachment as (p: string, o?: Record<string, boolean>) => Promise<void>)(
            attachmentPath, { buildAttachment: true }
        )

        const [log] = logCreatedEvent.mock.calls[0][0].logs
        expect(log.level).toBe('BuildLevel')
    })

    it('resolves a relative path against the process cwd', async () => {
        const relative = path.relative(process.cwd(), attachmentPath)
        await register()
        await (browser.uploadAttachment as (p: string) => Promise<void>)(relative)

        const [log] = logCreatedEvent.mock.calls[0][0].logs
        expect(log.filePath).toBe(snapshotOf('TestLevel'))
        expect(fs.readFileSync(log.filePath, 'utf8')).toBe('hello')
    })

    it('uploads a snapshot, so overwriting the source afterwards does not change the attachment', async () => {
        await register()
        await (browser.uploadAttachment as (p: string) => Promise<void>)(attachmentPath)
        fs.writeFileSync(attachmentPath, 'changed')

        const [log] = logCreatedEvent.mock.calls[0][0].logs
        expect(log.filePath).not.toBe(attachmentPath)
        expect(fs.readFileSync(log.filePath, 'utf8')).toBe('hello')
    })

    it('keeps an earlier snapshot of the same file name', async () => {
        await register()
        await (browser.uploadAttachment as (p: string) => Promise<void>)(attachmentPath)
        fs.writeFileSync(attachmentPath, 'second')
        await (browser.uploadAttachment as (p: string) => Promise<void>)(attachmentPath)

        expect(logCreatedEvent.mock.calls[1][0].logs[0].filePath).toBe(snapshotOf('TestLevel', 'media1.txt'))
        expect(fs.readFileSync(snapshotOf('TestLevel'), 'utf8')).toBe('hello')
        expect(fs.readFileSync(snapshotOf('TestLevel', 'media1.txt'), 'utf8')).toBe('second')
    })

    it('installNoopFallback makes uploadAttachment/uploadMedia callable without Test Reporting', async () => {
        const bare: Record<string, unknown> = {}
        UploadAttachmentModule.installNoopFallback(bare as never)

        expect(typeof bare.uploadAttachment).toBe('function')
        expect(bare.uploadMedia).toBe(bare.uploadAttachment)
        await expect((bare.uploadMedia as (p: string) => Promise<void>)(attachmentPath)).resolves.toBeUndefined()
        expect(logCreatedEvent).not.toHaveBeenCalled()
    })

    it('installNoopFallback leaves an implementation the module already registered', async () => {
        await register()
        const registered = browser.uploadAttachment
        UploadAttachmentModule.installNoopFallback(browser as never)
        expect(browser.uploadAttachment).toBe(registered)
    })

    it('onBeforeExecute replaces the no-op fallback with the real implementation', async () => {
        UploadAttachmentModule.installNoopFallback(browser as never)
        const fallback = browser.uploadAttachment
        await register()
        expect(browser.uploadAttachment).not.toBe(fallback)
        await (browser.uploadAttachment as (p: string) => Promise<void>)(attachmentPath)
        expect(logCreatedEvent).toHaveBeenCalledTimes(1)
    })

    it('cleanupUploadedAttachments removes only the UploadedAttachments-<n> folders', () => {
        fs.mkdirSync(path.join(writableDir, 'UploadedAttachments-0', 'TestLevel'), { recursive: true })
        fs.mkdirSync(path.join(writableDir, 'UploadedAttachments-3'), { recursive: true })
        fs.mkdirSync(path.join(writableDir, 'cli'), { recursive: true })

        UploadAttachmentModule.cleanupUploadedAttachments()

        expect(fs.readdirSync(writableDir).sort()).toEqual(['cli'])
    })

    it.each([
        ['an empty path', ''],
        ['a missing file', '/definitely/not/here.txt']
    ])('ignores %s without throwing', async (_label, input) => {
        await register()
        await expect(
            (browser.uploadAttachment as (p: string) => Promise<void>)(input)
        ).resolves.toBeUndefined()
        expect(logCreatedEvent).not.toHaveBeenCalled()
    })

    it('ignores a path that exists but is not a regular file', async () => {
        vi.spyOn(fs, 'statSync').mockReturnValue({
            isFile: () => false,
            size: 0
        } as never)

        await register()
        await (browser.uploadAttachment as (p: string) => Promise<void>)(attachmentPath)
        expect(logCreatedEvent).not.toHaveBeenCalled()
    })

    it('ignores a file above the 100 MB limit', async () => {
        vi.spyOn(fs, 'statSync').mockReturnValue({
            isFile: () => true,
            size: 101 * 1024 * 1024
        } as never)

        await register()
        await (browser.uploadAttachment as (p: string) => Promise<void>)(attachmentPath)
        expect(logCreatedEvent).not.toHaveBeenCalled()
    })

    it('returns to the caller without waiting for the binary to ack', async () => {
        vi.useFakeTimers()
        logCreatedEvent.mockReturnValueOnce(new Promise(() => {}))

        await register()
        // No timer advance: the caller must not be blocked on the never-settling ack.
        await expect(
            (browser.uploadAttachment as (p: string) => Promise<void>)(attachmentPath)
        ).resolves.toBeUndefined()
        expect(logCreatedEvent).toHaveBeenCalledTimes(1)

        const warn = vi.spyOn(BStackLogger, 'warn')
        await vi.advanceTimersByTimeAsync(UPLOAD_ATTACHMENT_ACK_TIMEOUT_MS)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`did not ack within ${UPLOAD_ATTACHMENT_ACK_TIMEOUT_MS}ms`))
    })

    it('does not throw when the ack rejects', async () => {
        logCreatedEvent.mockRejectedValueOnce(new Error('gRPC channel closed'))

        await register()
        await expect(
            (browser.uploadAttachment as (p: string) => Promise<void>)(attachmentPath)
        ).resolves.toBeUndefined()
    })

    it('does not throw when there is no tracked test to attribute to', async () => {
        await register()
        vi.mocked(TestFramework.getTrackedInstance).mockReturnValue(undefined as never)

        await expect(
            (browser.uploadAttachment as (p: string) => Promise<void>)(attachmentPath)
        ).resolves.toBeUndefined()
        expect(logCreatedEvent).not.toHaveBeenCalled()
    })
})
