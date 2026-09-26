import TestFramework from './testFramework.js'
import { BStackLogger as logger } from '../cliLogger.js'

/**
 * CLI test framework for `framework: 'jasmine'` under WebdriverIO.
 *
 * Extends the BASE TestFramework, never WdioMochaTestFramework: jasmine's identity (fullName),
 * hook taxonomy (`hookName`) and skip/exclude states differ from mocha's, and inheriting mocha's
 * event model would report jasmine specs through the wrong runner's semantics.
 */
export default class WdioJasmineTestFramework extends TestFramework {
    constructor(testFrameworks: string[], testFrameworkVersions: Record<string, string>, binSessionId: string) {
        super(testFrameworks, testFrameworkVersions, binSessionId)
        logger.debug('WdioJasmineTestFramework: constructed')
    }
}
