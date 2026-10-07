import path from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Frameworks } from '@wdio/types'

import {
    awaitCliTestFinishesOnFailure,
    claimCliTestFinish,
    cliTestAttemptKey,
    finishCliTestOnFailure,
    registerCliTestFinisher,
    resetCliTestFinishers
} from '../../src/cli/earlyTestFinish.js'
import * as bstackLogger from '../../src/bstackLogger.js'

vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))
vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

const failed = { passed: false, error: new Error('Timeout of 300000ms exceeded.'), duration: 300000, retries: { attempts: 0, limit: 0 }, exception: '', status: 'failed' } as Frameworks.TestResult

describe('SDK-7843 — a mocha test finish is reported exactly once, by whichever comes first', () => {
    beforeEach(() => {
        resetCliTestFinishers()
    })

    it('reports a timed-out test when mocha fails it, and the late afterTest then stands down', async () => {
        const finisher = vi.fn().mockResolvedValue(undefined)
        registerCliTestFinisher('Suite - times out', finisher)

        expect(finishCliTestOnFailure('Suite - times out', failed)).toBe(true)
        await awaitCliTestFinishesOnFailure()

        expect(finisher).toHaveBeenCalledOnce()
        expect(finisher).toHaveBeenCalledWith(failed)
        // wdio's afterTest for the same test arrives after after(); it must not report it again
        expect(claimCliTestFinish('Suite - times out')).toBe(false)
    })

    it('leaves a normal failure to afterTest, which runs before mocha reports it', () => {
        const finisher = vi.fn().mockResolvedValue(undefined)
        registerCliTestFinisher('Suite - fails normally', finisher)

        expect(claimCliTestFinish('Suite - fails normally')).toBe(true)
        expect(finishCliTestOnFailure('Suite - fails normally', failed)).toBe(false)
        expect(finisher).not.toHaveBeenCalled()
    })

    it('keeps afterTest responsible for a test that was never registered', () => {
        expect(claimCliTestFinish('Suite - never registered')).toBe(true)
        expect(finishCliTestOnFailure('Suite - never registered', failed)).toBe(false)
    })

    it('makes after() wait for a finish that is still in flight', async () => {
        let done = false
        registerCliTestFinisher('Suite - slow finish', () => new Promise<void>((resolve) => setTimeout(() => {
            done = true
            resolve()
        }, 100)))

        finishCliTestOnFailure('Suite - slow finish', failed)
        await awaitCliTestFinishesOnFailure()

        expect(done).toBe(true)
    })

    it('does not let a failing finish break after()', async () => {
        registerCliTestFinisher('Suite - finish throws', () => Promise.reject(new Error('gRPC down')))

        finishCliTestOnFailure('Suite - finish throws', failed)

        await expect(awaitCliTestFinishesOnFailure()).resolves.toBeUndefined()
    })

    it('keeps each retry attempt separate, so a late afterTest of one attempt cannot claim the next', () => {
        const first = vi.fn().mockResolvedValue(undefined)
        const second = vi.fn().mockResolvedValue(undefined)
        registerCliTestFinisher(cliTestAttemptKey('Suite - flaky', 0), first)
        registerCliTestFinisher(cliTestAttemptKey('Suite - flaky', 1), second)

        // attempt 0 timed out and was retried (mocha emits `retry`, not `fail`); its afterTest arrives late
        expect(claimCliTestFinish(cliTestAttemptKey('Suite - flaky', 0))).toBe(true)
        // attempt 1 is still owed, and can still be reported when mocha fails it
        expect(finishCliTestOnFailure(cliTestAttemptKey('Suite - flaky', 1), failed)).toBe(true)
        expect(second).toHaveBeenCalledWith(failed)
        expect(first).not.toHaveBeenCalled()
    })

    it('keys the first attempt by the plain identity', () => {
        expect(cliTestAttemptKey('Suite - t', 0)).toBe('Suite - t')
        expect(cliTestAttemptKey('Suite - t', undefined)).toBe('Suite - t')
        expect(cliTestAttemptKey('Suite - t', 2)).toBe('Suite - t (retry 2)')
    })

    it('without a reporter, after() finishes a test mocha already failed, from mocha\'s runnable', async () => {
        const finisher = vi.fn().mockResolvedValue(undefined)
        registerCliTestFinisher('Suite - times out', finisher, { state: 'failed', timedOut: true, duration: 10002, timeout: () => 10000 })

        await awaitCliTestFinishesOnFailure()

        expect(finisher).toHaveBeenCalledOnce()
        const result = finisher.mock.calls[0][0] as Frameworks.TestResult
        expect(result.passed).toBe(false)
        expect(result.duration).toBe(10002)
        expect((result.error as Error).message).toBe('Timeout of 10000ms exceeded.')
        // its late afterTest then stands down
        expect(claimCliTestFinish('Suite - times out')).toBe(false)
    })

    it('leaves a test mocha has not failed to its afterTest', async () => {
        const finisher = vi.fn().mockResolvedValue(undefined)
        registerCliTestFinisher('Suite - still running', finisher, { state: undefined })

        await awaitCliTestFinishesOnFailure()

        expect(finisher).not.toHaveBeenCalled()
        expect(claimCliTestFinish('Suite - still running')).toBe(true)
    })
})
