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
const UPLOADED_ATTACHMENTS_PREFIX = 'UploadedAttachments-wdio-'

/**
 * UploadAttachmentModule — CLI/gRPC path registration for `browser.uploadAttachment`
 * (aliased as `browser.uploadMedia`).
 *
 * Mirrors CustomTagsModule: registers the browser method in onBeforeExecute()
 * (observer-bound to AutomationFrameworkState.CREATE / HookState.POST), instantiated
 * from BrowserstackCLI.loadModules() whenever the binary is up.
 *
 * The binary streams the file from `filePath` only when it drains its upload queue, so the
 * file is snapshotted first: a caller that overwrites or deletes its file right after the call
 * would otherwise attach the wrong content or nothing. Snapshots go to
 * `UploadedAttachments-wdio-<bin session id>/<worker pid>/<level>/` under the writable dir:
 * per worker, so parallel workers never pick the same name, and per wdio run, so the Python
 * and Java SDKs (`UploadedAttachments-<n>/`) and other runs on the host never read or delete
 * them. The launcher removes this run's folder in onComplete. `level` is what the binary
 * switches on to pick test_run_uuid / hook_run_uuid / build_run_uuid.
 */
export default class UploadAttachmentModule extends BaseModule {

    logger = BStackLogger
    name: string
    static MODULE_NAME = 'UploadAttachmentModule'

    private pendingSends = new Set<Promise<void>>()

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

        const snapshotPath = UploadAttachmentModule.snapshot(resolvedPath, target.level)
        if (!snapshotPath) {
            this.logger.warn(`uploadAttachment: could not snapshot ${resolvedPath}; ignoring call`)
            return
        }

        this.sendAttachmentEvent(instance, snapshotPath, stats.size, target, UploadAttachmentModule.platformIndex())
    }

    private static platformIndex() {
        return process.env.WDIO_WORKER_ID ? parseInt(process.env.WDIO_WORKER_ID.split('-')[0]) : 0
    }

    private static runAttachmentsDir(): string | null {
        const root = CLIUtils.getWritableDir()
        const runId = process.env.BROWSERSTACK_CLI_BIN_SESSION_ID
        return root && runId ? path.join(root, `${UPLOADED_ATTACHMENTS_PREFIX}${runId}`) : null
    }

    private static snapshot(sourcePath: string, level: AttachmentLevel): string | null {
        try {
            const runDir = UploadAttachmentModule.runAttachmentsDir()
            if (!runDir) {
                return null
            }
            const targetDir = path.join(runDir, String(process.pid), level)
            fs.mkdirSync(targetDir, { recursive: true })
            const ext = path.extname(sourcePath)
            const base = path.basename(sourcePath, ext)
            for (let counter = 0; ; counter++) {
                const targetPath = path.join(targetDir, counter ? `${base}${counter}${ext}` : `${base}${ext}`)
                try {
                    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
                    return targetPath
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                        throw error
                    }
                }
            }
        } catch (error) {
            BStackLogger.debug(`uploadAttachment: snapshot of ${sourcePath} failed: ${error}`)
            return null
        }
    }

    /**
     * Keeps uploadAttachment/uploadMedia callable when Test Reporting is inactive (no testhub,
     * classic path, CLI down), as the other SDKs do. onBeforeExecute replaces it when the
     * binary is up, and an already-registered implementation is left alone.
     */
    static installNoopFallback(browser?: WebdriverIO.Browser) {
        if (!browser || typeof browser.uploadAttachment === 'function') {
            return
        }
        const noopUploadAttachment = async (filePath: string) => {
            BStackLogger.debug(`uploadAttachment: Test Reporting is not active; ${filePath} was not uploaded`)
        }
        browser.uploadAttachment = noopUploadAttachment
        browser.uploadMedia = noopUploadAttachment
    }

    static cleanupUploadedAttachments() {
        try {
            const runDir = UploadAttachmentModule.runAttachmentsDir()
            if (runDir) {
                fs.rmSync(runDir, { recursive: true, force: true })
            }
        } catch (error) {
            BStackLogger.debug(`uploadAttachment: cleanup of attachment snapshots failed: ${error}`)
        }
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

    /**
     * Dispatch and return — deliberately NOT awaited by the caller.
     *
     * uploadAttachment is called from the customer's test body, and the very next statement
     * is usually a browser command that the accessibility module wraps with a pre-command
     * scan. Awaiting a binary round-trip on that stack was observed to stall the following
     * `executeAsync` scan under load (chrome sessions reaped at the framework timeout), so
     * the event is written and its ack observed off the caller's stack. The ack carries no
     * information the caller can act on: the binary streams the file from `filePath` while
     * draining its own upload queue.
     */
    private sendAttachmentEvent(
        instance: TestFrameworkInstance,
        filePath: string,
        fileSize: number,
        target: { level: AttachmentLevel, uuid: string, testFrameworkState: string },
        platformIndex: number
    ) {
        const testData = instance.getAllData()
        const trackedContext = instance.getContext()

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

        let timer: NodeJS.Timeout | undefined
        const observed = Promise.race([
            ack.then(() => 'ok', (error) => `failed: ${error}`),
            new Promise<string>((resolve) => {
                timer = setTimeout(() => resolve('unacked'), UPLOAD_ATTACHMENT_ACK_TIMEOUT_MS)
                timer.unref()
            })
        ]).then((outcome) => {
            clearTimeout(timer)
            if (outcome === 'ok') {
                this.logger.debug(`uploadAttachment: sent ${target.level} attachment ${filePath} (${fileSize} bytes) for uuid=${target.uuid}`)
            } else if (outcome === 'unacked') {
                this.logger.warn(`uploadAttachment: ${filePath} was sent but the binary did not ack within ${UPLOAD_ATTACHMENT_ACK_TIMEOUT_MS}ms`)
            } else {
                this.logger.warn(`uploadAttachment: could not record ${filePath} — ${outcome}`)
            }
        })

        // Held only so the send is never an unobserved promise; pruned as they settle.
        this.pendingSends.add(observed)
        observed.finally(() => this.pendingSends.delete(observed))
    }
}
