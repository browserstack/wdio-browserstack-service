import { vi } from 'vitest'

import { EventEmitter } from 'node:events'
import { Chalk } from '../chalk.ts'

// Stub stats classes. These MUST NOT be imported from '@wdio/reporter' — this file IS
// the mock for '@wdio/reporter', so importing the stats from it makes the mock depend
// on itself and deadlocks mock resolution at collection (the file hangs with no
// output). The service only uses these as TYPES (erased at runtime) and the specs use
// plain object literals, so empty classes are sufficient. (In the monorepo the mock
// imported them from packages/wdio-reporter/src, a path that doesn't exist standalone.)
export class HookStats {}
export class RunnerStats {}
export class SuiteStats {}
export class TestStats {}

export default class WDIOReporter extends EventEmitter {
    outputStream: { write: Function }
    failures: number
    suites: Record<string, SuiteStats>
    hooks: Record<string, HookStats>
    tests: Record<string, TestStats>
    currentSuites: SuiteStats[]
    counts: {
        suites: number
        tests: number
        hooks: number
        passes: number
        skipping: number
        failures: number
    }
    retries: number
    _chalk: Chalk
    runnerStat?: RunnerStats
    constructor (public options: any) {
        super()
        this.options = options
        this.outputStream = { write: vi.fn() }
        this.failures = 0
        this.suites = {}
        this.hooks = {}
        this.tests = {}
        this.currentSuites = []
        this.counts = {
            suites: 0,
            tests: 0,
            hooks: 0,
            passes: 0,
            skipping: 0,
            failures: 0
        }
        this.retries = 0
        this._chalk = new Chalk(!options.color ? { level : 0 } : {})
    }

    get isSynchronised () {
        return true
    }

    write (content: any) {
        this.outputStream.write(content)
    }

    /* istanbul ignore next */
    onRunnerStart () {}
    /* istanbul ignore next */
    onBeforeCommand () {}
    /* istanbul ignore next */
    onAfterCommand () {}
    /* istanbul ignore next */
    onSuiteStart () {}
    /* istanbul ignore next */
    onHookStart () {}
    /* istanbul ignore next */
    onHookEnd () {}
    /* istanbul ignore next */
    onTestStart () {}
    /* istanbul ignore next */
    onTestPass () {}
    /* istanbul ignore next */
    onTestFail () {}
    /* istanbul ignore next */
    onTestSkip () {}
    /* istanbul ignore next */
    onTestEnd () {}
    /* istanbul ignore next */
    onSuiteEnd () {}
    /* istanbul ignore next */
    onRunnerEnd () {}
}
