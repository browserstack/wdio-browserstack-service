import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import TestMetadata from '../src/metadata.js'
import BrowserStackSDK from '../src/browserStackSdk.js'
import * as bstackLogger from '../src/bstackLogger.js'
import { BROWSERSTACK_CENTRAL_USER } from '../src/constants.js'

describe('TestMetadata', () => {
    let warnSpy: any
    const originalCentralUser = process.env[BROWSERSTACK_CENTRAL_USER]

    beforeEach(() => {
        process.env[BROWSERSTACK_CENTRAL_USER] = 'app_lcnc'
        TestMetadata.reset()
        warnSpy = vi.spyOn(bstackLogger.BStackLogger, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
        TestMetadata.reset()
        warnSpy.mockRestore()
        if (originalCentralUser === undefined) {
            delete process.env[BROWSERSTACK_CENTRAL_USER]
        } else {
            process.env[BROWSERSTACK_CENTRAL_USER] = originalCentralUser
        }
    })

    describe('central-user gating', () => {
        it('set() is a no-op and get() returns {} when central user is not app_lcnc', () => {
            delete process.env[BROWSERSTACK_CENTRAL_USER]
            TestMetadata.set({ identifier: 'abc' })
            expect(TestMetadata.get()).toEqual({})
        })

        it('get() returns {} when central user is not app_lcnc even if data was stored while enabled', () => {
            TestMetadata.set({ identifier: 'abc' })
            delete process.env[BROWSERSTACK_CENTRAL_USER]
            expect(TestMetadata.get()).toEqual({})
        })
    })

    describe('set() validation', () => {
        it('warns and ignores when identifier is not a string', () => {
            TestMetadata.set({ identifier: 123 as any })
            expect(warnSpy).toHaveBeenCalled()
            expect(TestMetadata.get()).toEqual({})
        })

        it('warns and ignores when identifier is missing', () => {
            TestMetadata.set({ foo: 'bar' })
            expect(warnSpy).toHaveBeenCalled()
            expect(TestMetadata.get()).toEqual({})
        })

        it('warns and ignores when identifier exceeds 40 characters', () => {
            const tooLong = 'x'.repeat(41)
            TestMetadata.set({ identifier: tooLong })
            expect(warnSpy).toHaveBeenCalled()
            expect(TestMetadata.get()).toEqual({})
        })

        it('accepts an identifier of exactly 40 characters', () => {
            const exactly40 = 'x'.repeat(40)
            TestMetadata.set({ identifier: exactly40 })
            expect(warnSpy).not.toHaveBeenCalled()
            expect(TestMetadata.get()).toEqual({ identifier: exactly40 })
        })
    })

    describe('fallback vs per-uuid storage', () => {
        it('stores as fallback for the no-uuid (current-run) lookup, but not for unknown uuids', () => {
            TestMetadata.set({ identifier: 'run-1' })
            expect(TestMetadata.get()).toEqual({ identifier: 'run-1' })
            // A per-uuid lookup must not leak the current-run fallback.
            expect(TestMetadata.get('unknown-uuid')).toEqual({})
        })

        it('stores per-uuid when a current test-run uuid is set', () => {
            TestMetadata.setCurrentTestRunUuid('uuid-1')
            TestMetadata.set({ identifier: 'run-1' })
            expect(TestMetadata.get('uuid-1')).toEqual({ identifier: 'run-1' })
        })

        it('returns {} for an unknown uuid instead of leaking another run\'s metadata', () => {
            TestMetadata.setCurrentTestRunUuid('uuid-1')
            TestMetadata.set({ identifier: 'run-1' })
            expect(TestMetadata.get('uuid-2')).toEqual({})
        })

        it('returns the correct metadata per uuid across multiple test runs', () => {
            TestMetadata.setCurrentTestRunUuid('uuid-1')
            TestMetadata.set({ identifier: 'run-1' })
            TestMetadata.setCurrentTestRunUuid('uuid-2')
            TestMetadata.set({ identifier: 'run-2' })
            expect(TestMetadata.get('uuid-1')).toEqual({ identifier: 'run-1' })
            expect(TestMetadata.get('uuid-2')).toEqual({ identifier: 'run-2' })
        })
    })

    describe('reset()', () => {
        it('clears current uuid, per-uuid store and fallback', () => {
            TestMetadata.setCurrentTestRunUuid('uuid-1')
            TestMetadata.set({ identifier: 'run-1' })
            TestMetadata.reset()
            expect(TestMetadata.get()).toEqual({})
            expect(TestMetadata.get('uuid-1')).toEqual({})
        })
    })
})

describe('BrowserStackSDK.setTestMetadata', () => {
    const originalCentralUser = process.env[BROWSERSTACK_CENTRAL_USER]

    beforeEach(() => {
        process.env[BROWSERSTACK_CENTRAL_USER] = 'app_lcnc'
        TestMetadata.reset()
        vi.spyOn(bstackLogger.BStackLogger, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
        TestMetadata.reset()
        vi.restoreAllMocks()
        if (originalCentralUser === undefined) {
            delete process.env[BROWSERSTACK_CENTRAL_USER]
        } else {
            process.env[BROWSERSTACK_CENTRAL_USER] = originalCentralUser
        }
    })

    it('delegates to TestMetadata.set', () => {
        const setSpy = vi.spyOn(TestMetadata, 'set')
        BrowserStackSDK.setTestMetadata({ identifier: 'run-1' })
        expect(setSpy).toHaveBeenCalledWith({ identifier: 'run-1' })
    })

    it('makes the metadata retrievable via TestMetadata.get', () => {
        BrowserStackSDK.setTestMetadata({ identifier: 'run-1' })
        expect(TestMetadata.get()).toEqual({ identifier: 'run-1' })
    })

    it('defaults to an empty object when called with no argument', () => {
        expect(() => BrowserStackSDK.setTestMetadata()).not.toThrow()
        expect(TestMetadata.get()).toEqual({})
    })
})
