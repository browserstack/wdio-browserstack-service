import type { Options } from '@wdio/types'
import { describe, expect, it } from 'vitest'

import { createHookAffectedTestError, mochaFailsHookAffectedTests } from '../src/util.js'

const mochaConfig = (mochaOpts?: Record<string, unknown>) =>
    ({ framework: 'mocha', mochaOpts }) as unknown as Options.Testrunner

describe('mochaFailsHookAffectedTests', () => {
    it('is true on WebdriverIO 10 when the option is not set', () => {
        expect(mochaFailsHookAffectedTests(mochaConfig(), 10)).toBe(true)
        expect(mochaFailsHookAffectedTests(mochaConfig({ timeout: 1000 }), 10)).toBe(true)
    })

    it('is true on WebdriverIO 10 when the option is true', () => {
        expect(mochaFailsHookAffectedTests(mochaConfig({ failHookAffectedTests: true }), 10)).toBe(true)
    })

    it('is false on WebdriverIO 10 when the user turned the option off', () => {
        expect(mochaFailsHookAffectedTests(mochaConfig({ failHookAffectedTests: false }), 10)).toBe(false)
    })

    it('is false on WebdriverIO 9, which uses a Mocha without the option', () => {
        expect(mochaFailsHookAffectedTests(mochaConfig({ failHookAffectedTests: true }), 9)).toBe(false)
    })

    it('is false when the WebdriverIO version is unknown', () => {
        expect(mochaFailsHookAffectedTests(mochaConfig(), undefined)).toBe(false)
    })

    it('is false for other frameworks', () => {
        expect(mochaFailsHookAffectedTests({ framework: 'jasmine' } as Options.Testrunner, 10)).toBe(false)
        expect(mochaFailsHookAffectedTests(undefined, 10)).toBe(false)
    })
})

describe('createHookAffectedTestError', () => {
    it('gives the message and stack that Mocha 12 gives the affected tests', () => {
        const hookError = new Error('login failed')
        const error = createHookAffectedTestError('"before all" hook for "logs in"', hookError)

        expect(error.message).toBe('Test skipped due to failure in hook ""before all" hook for "logs in"": login failed')
        expect(error.stack).toBe(hookError.stack)
    })

    it('handles a hook that failed without an error', () => {
        const error = createHookAffectedTestError('"before each" hook', undefined)

        expect(error.message).toBe('Test skipped due to failure in hook ""before each" hook": Hook failed')
    })
})
