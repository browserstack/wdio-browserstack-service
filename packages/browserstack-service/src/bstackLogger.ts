import path from 'node:path'
import fs from 'node:fs'
import chalk from 'chalk'

import logger from '@wdio/logger'

import { LOGS_FILE } from './constants.js'
import { COLORS } from './util.js'

const log = logger('@wdio/browserstack-service')

export class BStackLogger {
    public static logFilePath = path.join(process.cwd(), LOGS_FILE)
    public static logFolderPath = path.join(process.cwd(), 'logs')
    private static logFileStream: fs.WriteStream | null

    private static redactCredentials(logMessage: string): string {
        return logMessage
            .replace(/(["']?(?:username|userName|accesskey|accessKey|user|key)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi, '$1')
            .replace(/([?&](?:username|userName|access_key|accesskey|accessKey|user|key)=)([^&#\s]+)/gi, '$1')
    }

    static logToFile(logMessage: string, logLevel: string) {
        try {
            const redactedMessage = this.redactCredentials(logMessage)
            if (!this.logFileStream) {
                this.ensureLogsFolder()
                this.logFileStream = fs.createWriteStream(this.logFilePath, { flags: 'a' })
            }
            if (this.logFileStream && this.logFileStream.writable) {
                this.logFileStream.write(this.formatLog(redactedMessage, logLevel))
            }
        } catch (error) {
            log.debug(`Failed to log to file. Error ${error}`)
        }
    }

    private static formatLog(logMessage: string, level: string) {
        return `${chalk.gray(new Date().toISOString())} ${chalk[COLORS[level]](level.toUpperCase())} ${chalk.whiteBright('@wdio/browserstack-service')} ${logMessage}\n`
    }

    public static info(message: string) {
        const redactedMessage = this.redactCredentials(message)
        this.logToFile(redactedMessage, 'info')
        log.info(redactedMessage)
    }

    public static error(message: string) {
        const redactedMessage = this.redactCredentials(message)
        this.logToFile(redactedMessage, 'error')
        log.error(redactedMessage)
    }

    public static debug(message: string, param?: unknown) {
        const redactedMessage = this.redactCredentials(message)
        this.logToFile(redactedMessage, 'debug')
        if (param) {
            log.debug(redactedMessage, param)
        } else {
            log.debug(redactedMessage)
        }
    }

    public static warn(message: string) {
        const redactedMessage = this.redactCredentials(message)
        this.logToFile(redactedMessage, 'warn')
        log.warn(redactedMessage)
    }

    public static trace(message: string) {
        const redactedMessage = this.redactCredentials(message)
        this.logToFile(redactedMessage, 'trace')
        log.trace(redactedMessage)
    }

    /**
     * Drain whatever is still sitting in the log stream's buffer onto disk.
     *
     * `logToFile` writes to an async `fs.WriteStream`, so a line logged immediately before the
     * archive is built is very likely NOT in the file yet — the stream's `open` is async too,
     * so early on the file may not exist at all. Anything that snapshots the log (the debug-log
     * upload) must flush first or it ships a truncated copy.
     *
     * A zero-length write's callback fires only after every chunk queued ahead of it has been
     * handed to the fs layer, which drains the buffer without ending the stream — unlike
     * `clearLogger()`, logging continues to work afterwards.
     */
    public static async flushLogFile(timeoutMs = 2000): Promise<void> {
        const stream = this.logFileStream
        if (!stream || !stream.writable) {
            return
        }
        // Never let a stuck stream hold up the upload; a truncated log beats no log at all.
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, timeoutMs)
            timer.unref?.()
            stream.write('', () => {
                clearTimeout(timer)
                resolve()
            })
        })
    }

    public static clearLogger() {
        if (this.logFileStream) {
            this.logFileStream.end()
        }
        this.logFileStream = null
    }

    public static clearLogFile() {
        if (fs.existsSync(this.logFilePath)) {
            fs.truncateSync(this.logFilePath)
        }
    }

    public static ensureLogsFolder() {
        if (!fs.existsSync(this.logFolderPath)){
            fs.mkdirSync(this.logFolderPath)
        }
    }
}
