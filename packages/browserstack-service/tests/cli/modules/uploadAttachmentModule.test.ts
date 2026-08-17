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
    let browser: Record<string, unknown>

    beforeEach(() => {
        vi.clearAllMocks()
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-attachment-test-'))
        attachmentPath = path.join(tmpDir, 'media.txt')
        fs.writeFileSync(attachmentPath, 'hello')

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
            filePath: attachmentPath
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
        expect(log.filePath).toBe(attachmentPath)
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

    it('ignores a file above the 100 MB limit', async () => {
        vi.spyOn(fs, 'statSync').mockReturnValue({
            isFile: () => true,
            size: 101 * 1024 * 1024
        } as never)

        await register()
        await (browser.uploadAttachment as (p: string) => Promise<void>)(attachmentPath)
        expect(logCreatedEvent).not.toHaveBeenCalled()
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
