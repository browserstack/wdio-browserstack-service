import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { BStackLogger } from '../bstackLogger.js'

interface Scripts {
    scan: string
    getResults: string
    getResultsSummary: string
    saveResults: string
}

interface Command {
    name: string
    class: string
}

/**
 * The binary types AccessibilityCapability.value as a proto string, so goog:chromeOptions
 * arrives JSON-encoded over gRPC where the HTTP launch response delivers a plain object.
 * Accept both. Anything that does not resolve to an object is dropped rather than written
 * into a W3C capability, which the hub rejects outright.
 */
function toChromeOptions(value: unknown): { [key: string]: unknown } | null {
    // An absent field is the common case and not a drop — update() runs on every launch response
    // and every readFromExistingFile(), so reporting it would bury the drop this logs for.
    if (value === undefined || value === null) {
        return null
    }

    let parsed = value
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed)
        } catch (err) {
            // Dropping this leaves the extension uninjected and the a11y report empty, with the
            // run still green — so the drop has to be findable in the log.
            BStackLogger.debug(`toChromeOptions: goog:chromeOptions is not valid JSON, dropping it: ${err}`)
            return null
        }
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as { [key: string]: unknown }
    }
    BStackLogger.debug(`toChromeOptions: goog:chromeOptions resolved to ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object; dropping it`)
    return null
}

class AccessibilityScripts {
    private static instance: AccessibilityScripts | null = null

    public performScan: string | null = null
    public getResults: string | null = null
    public getResultsSummary: string | null = null
    public saveTestResults: string | null = null
    public commandsToWrap: Array<Command> | null = null
    public ChromeExtension: { [key: string]: unknown } = {}

    public browserstackFolderPath = ''
    public commandsPath = ''

    // don't allow to create instances from it other than through `checkAndGetInstance`
    private constructor() {
        this.browserstackFolderPath = this.getWritableDir()
        this.commandsPath = path.join(this.browserstackFolderPath, 'commands.json')
    }

    public static checkAndGetInstance() {
        if (!AccessibilityScripts.instance) {
            AccessibilityScripts.instance = new AccessibilityScripts()
            AccessibilityScripts.instance.readFromExistingFile()
        }
        return AccessibilityScripts.instance
    }

    /* eslint-disable @typescript-eslint/no-unused-vars */
    public getWritableDir(): string {
        const orderedPaths = [
            path.join(os.homedir(), '.browserstack'),
            process.cwd(),
            os.tmpdir()
        ]
        for (const orderedPath of orderedPaths) {
            try {
                if (fs.existsSync(orderedPath)) {
                    fs.accessSync(orderedPath)
                    return orderedPath
                }

                fs.mkdirSync(orderedPath, { recursive: true })
                return orderedPath

            } catch (error) {
                /* no-empty */
            }
        }
        return ''
    }

    public readFromExistingFile() {
        try {
            if (fs.existsSync(this.commandsPath)) {
                const data = fs.readFileSync(this.commandsPath, 'utf8')
                if (data) {
                    this.update(JSON.parse(data))
                }
            }
        } catch {
            /* Do nothing */
        }
    }

    public update(data: { commands: [], scripts: Scripts, nonBStackInfraA11yChromeOptions: {} }) {
        if (data.scripts) {
            this.performScan = data.scripts.scan
            this.getResults = data.scripts.getResults
            this.getResultsSummary = data.scripts.getResultsSummary
            this.saveTestResults = data.scripts.saveResults
        }
        if (data.commands && data.commands.length) {
            this.commandsToWrap = data.commands
        }
        const chromeOptions = toChromeOptions(data.nonBStackInfraA11yChromeOptions)
        if (chromeOptions){
            this.ChromeExtension = chromeOptions
        }

    }

    public store() {
        if (!fs.existsSync(this.browserstackFolderPath)){
            fs.mkdirSync(this.browserstackFolderPath)
        }

        fs.writeFileSync(this.commandsPath, JSON.stringify({
            commands: this.commandsToWrap,
            scripts: {
                scan: this.performScan,
                getResults: this.getResults,
                getResultsSummary: this.getResultsSummary,
                saveResults: this.saveTestResults,
            },
            nonBStackInfraA11yChromeOptions: this.ChromeExtension,
        }))
    }
}

export default AccessibilityScripts.checkAndGetInstance()
export { Command }
