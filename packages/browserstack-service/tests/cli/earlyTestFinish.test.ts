import path from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Frameworks } from '@wdio/types'

import {
    awaitCliTestFinishesOnFailure,
    claimCliTestFinish,
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
})
