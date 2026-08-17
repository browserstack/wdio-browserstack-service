/// <reference path="../../@types/bstack-service-types.d.ts" />
import fs from 'node:fs'
import path from 'node:path'
import BaseModule from './baseModule.js'
import { BStackLogger } from '../cliLogger.js'
import TestFramework from '../frameworks/testFramework.js'
import AutomationFramework from '../frameworks/automationFramework.js'
import type AutomationFrameworkInstance from '../instances/automationFrameworkInstance.js'
import type TestFrameworkInstance from '../instances/testFrameworkInstance.js'
import { AutomationFrameworkState } from '../states/automationFrameworkState.js'
import { HookState } from '../states/hookState.js'
import { TestFrameworkConstants } from '../frameworks/constants/testFrameworkConstants.js'
import { CLIUtils } from '../cliUtils.js'
import WdioMochaTestFramework from '../frameworks/wdioMochaTestFramework.js'
import { GrpcClient } from '../grpcClient.js'
import { UPLOAD_ATTACHMENT_ACK_TIMEOUT_MS } from '../../constants.js'
import type { AttachmentLevel, AttachmentOptions } from '../../types.js'

/** Parity with the Java / Python / Node SDKs, which all reject above 100 MB. */
const MAX_ATTACHMENT_SIZE_BYTES = 100 * 1024 * 1024

/**
 * UploadAttachmentModule — CLI/gRPC path registration for `browser.uploadAttachment`
 * (aliased as `browser.uploadMedia`).
 *
 * Mirrors CustomTagsModule: registers the browser method in onBeforeExecute()
 * (observer-bound to AutomationFrameworkState.CREATE / HookState.POST), instantiated
 * from BrowserstackCLI.loadModules() whenever the binary is up.
 *
 * The file itself is NOT copied. The binary streams it from `filePath` when it drains
 * its upload queue, which can be after this process has moved on — so the entry carries
 * the caller's own absolute path, and the binary reads it in place. `level` is what the
 * binary switches on to pick test_run_uuid / hook_run_uuid / build_run_uuid.
 */
export default class UploadAttachmentModule extends BaseModule {

    logger = BStackLogger
    name: string
    static MODULE_NAME = 'UploadAttachmentModule'

    constructor() {
        super()
        this.name = UploadAttachmentModule.MODULE_NAME
        AutomationFramework.registerObserver(AutomationFrameworkState.CREATE, HookState.POST, this.onBeforeExecute.bind(this))
    }

    getModuleName() {
        return UploadAttachmentModule.MODULE_NAME
    }

    async onBeforeExecute() {
        try {
            const autoInstance: AutomationFrameworkInstance = AutomationFramework.getTrackedInstance()
            if (!autoInstance) {
                this.logger.debug('UploadAttachmentModule: No tracked automation instance found!')
                return
            }

            const browser = AutomationFramework.getDriver(autoInstance) as WebdriverIO.Browser
            if (!browser) {
                this.logger.debug('UploadAttachmentModule: No browser instance found for uploadAttachment registration')
                return
            }

            const uploadAttachment = async (filePath: string, options?: AttachmentOptions): Promise<void> => {
                try {
                    await this.recordAttachment(filePath, options)
                } catch (error) {
                    this.logger.warn(`uploadAttachment: error while recording attachment: ${error}`)
                }
            }

            browser.uploadAttachment = uploadAttachment
            browser.uploadMedia = uploadAttachment
        } catch (error) {
            this.logger.error(`Error in UploadAttachmentModule.onBeforeExecute: ${error}`)
        }
    }

    private async recordAttachment(filePath: string, options?: AttachmentOptions) {
        if (!filePath || !filePath.trim()) {
            this.logger.warn('uploadAttachment: file path is required; ignoring call')
            return
        }

        const resolvedPath = path.resolve(filePath.trim())
        let stats: fs.Stats
        try {
            stats = fs.statSync(resolvedPath)
        } catch {
            this.logger.warn(`uploadAttachment: file does not exist at ${resolvedPath}; ignoring call`)
            return
        }

        if (!stats.isFile()) {
            this.logger.warn(`uploadAttachment: ${resolvedPath} is not a file; ignoring call`)
            return
        }

        if (stats.size > MAX_ATTACHMENT_SIZE_BYTES) {
            this.logger.warn(`uploadAttachment: ${resolvedPath} is ${stats.size} bytes, above the ${MAX_ATTACHMENT_SIZE_BYTES}-byte limit; ignoring call`)
            return
        }

        const instance: TestFrameworkInstance = TestFramework.getTrackedInstance()
        if (!instance) {
            this.logger.debug('uploadAttachment: no tracked test instance; cannot attribute the attachment, ignoring call')
            return
        }

        const target = this.resolveTarget(instance, options)
        if (!target) {
            this.logger.debug('uploadAttachment: could not resolve a test or hook to attach to; ignoring call')
            return
        }

        await this.sendAttachmentEvent(instance, resolvedPath, stats.size, target)
    }

    /**
     * Pick the attachment level and the uuid it hangs off. A build-level attachment still
     * needs a uuid on the wire — the binary drops log entries without one before it ever
     * reads `level` — so it reuses whichever test/hook uuid is current and the binary
     * substitutes the build id downstream.
     */
    private resolveTarget(instance: TestFrameworkInstance, options?: AttachmentOptions): { level: AttachmentLevel, uuid: string, testFrameworkState: string } | null {
        const testFrameworkState = instance.getCurrentTestState().toString().split('.')[1] ?? ''
        const inHook = CLIUtils.matchHookRegex(testFrameworkState)
        const hook = inHook ? WdioMochaTestFramework.lastActiveHook(instance, WdioMochaTestFramework.KEY_HOOK_LAST_STARTED) : null
        const hookUuid = hook ? hook[TestFrameworkConstants.KEY_HOOK_ID] as string : ''
        const testUuid = TestFramework.getState(instance, TestFrameworkConstants.KEY_TEST_UUID) as string

        const uuid = hookUuid || testUuid
        if (!uuid) {
            return null
        }

        if (options?.buildAttachment) {
            return { level: 'BuildLevel', uuid, testFrameworkState }
        }
        return hookUuid
            ? { level: 'HookLevel', uuid: hookUuid, testFrameworkState }
            : { level: 'TestLevel', uuid: testUuid, testFrameworkState }
    }

    private async sendAttachmentEvent(
        instance: TestFrameworkInstance,
        filePath: string,
        fileSize: number,
        target: { level: AttachmentLevel, uuid: string, testFrameworkState: string }
    ) {
        const testData = instance.getAllData()
        const trackedContext = instance.getContext()
        const platformIndex = process.env.WDIO_WORKER_ID ? parseInt(process.env.WDIO_WORKER_ID.split('-')[0]) : 0

        const ack = GrpcClient.getInstance().logCreatedEvent({
            platformIndex,
            executionContext: {
                hash: trackedContext.getId(),
                threadId: trackedContext.getThreadId().toString(),
                processId: trackedContext.getProcessId().toString()
            },
            logs: [{
                testFrameworkName: (testData.get(TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME) as string) || '',
                testFrameworkVersion: (testData.get(TestFrameworkConstants.KEY_TEST_FRAMEWORK_VERSION) as string) || '',
                testFrameworkState: target.testFrameworkState,
                uuid: target.uuid,
                kind: TestFrameworkConstants.KIND_ATTACHMENT,
                message: new Uint8Array(),
                timestamp: new Date().toISOString(),
                level: target.level,
                fileName: path.basename(filePath),
                fileSize,
                filePath
            }]
        })

        // This runs inside the customer's test body, so only the ack is raced — the event
        // is already written by the time the timer can fire. Mapping the rejection into the
        // race keeps a late gRPC error from surfacing as an unhandled rejection.
        let timer: NodeJS.Timeout | undefined
        const outcome = await Promise.race([
            ack.then(() => 'ok', (error) => `failed: ${error}`),
            new Promise<string>((resolve) => {
                timer = setTimeout(() => resolve('unacked'), UPLOAD_ATTACHMENT_ACK_TIMEOUT_MS)
            })
        ])
        clearTimeout(timer)

        if (outcome === 'ok') {
            this.logger.debug(`uploadAttachment: sent ${target.level} attachment ${filePath} (${fileSize} bytes) for uuid=${target.uuid}`)
        } else if (outcome === 'unacked') {
            this.logger.warn(`uploadAttachment: ${filePath} was sent but the binary did not ack within ${UPLOAD_ATTACHMENT_ACK_TIMEOUT_MS}ms; not waiting further`)
        } else {
            this.logger.warn(`uploadAttachment: could not record ${filePath} — ${outcome}`)
        }
    }
}
