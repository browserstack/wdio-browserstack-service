import { describe, expect, it, vi, afterEach } from 'vitest'
import * as bstackLogger from '../../src/bstackLogger.js'

import { BrowserstackCLI } from '../../src/cli/index.js'
import { CLIUtils } from '../../src/cli/cliUtils.js'
import TestFramework from '../../src/cli/frameworks/testFramework.js'
import WdioMochaTestFramework from '../../src/cli/frameworks/wdioMochaTestFramework.js'
import WdioCucumberTestFramework from '../../src/cli/frameworks/wdioCucumberTestFramework.js'
import WdioJasmineTestFramework from '../../src/cli/frameworks/wdioJasmineTestFramework.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

describe('CLIUtils.checkCLISupportedFrameworks', () => {
    it.each(['mocha', 'cucumber', 'jasmine'])('routes %s to the CLI flow', (framework) => {
        expect(CLIUtils.checkCLISupportedFrameworks(framework)).toBe(true)
    })

    it.each([undefined, 'WebdriverIO-jasmine', 'Jasmine', 'unknown'])('keeps %s on the legacy flow', (framework) => {
        expect(CLIUtils.checkCLISupportedFrameworks(framework)).toBe(false)
    })
})

describe('BrowserstackCLI.setupTestFramework', () => {
    const cli = BrowserstackCLI.getInstance()

    afterEach(() => {
        vi.restoreAllMocks()
        cli.testFramework = null
    })

    const setup = (name: string) => {
        vi.spyOn(CLIUtils, 'getTestFrameworkDetail').mockReturnValue({ name, version: { [name]: '9.0.0' } })
        cli.setupTestFramework()
        return cli.getTestFramework()
    }

    it('constructs the jasmine framework for WebdriverIO-jasmine', () => {
        const framework = setup('WebdriverIO-jasmine')
        expect(framework).toBeInstanceOf(WdioJasmineTestFramework)
        expect(framework).not.toBeInstanceOf(WdioMochaTestFramework)
        expect(framework).toBeInstanceOf(TestFramework)
        expect(framework!.getTestFrameworks()).toEqual(['WebdriverIO-jasmine'])
        expect(framework!.getTestFrameworksVersions()).toEqual({ 'WebdriverIO-jasmine': '9.0.0' })
    })

    it('still constructs the mocha framework for WebdriverIO-mocha', () => {
        expect(setup('WebdriverIO-mocha')).toBeInstanceOf(WdioMochaTestFramework)
    })

    it('still constructs the cucumber framework for WebdriverIO-cucumber', () => {
        expect(setup('WebdriverIO-cucumber')).toBeInstanceOf(WdioCucumberTestFramework)
    })

    it('leaves an unknown name unregistered', () => {
        expect(setup('WebdriverIO-unknown')).toBeNull()
    })
})
