import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('../src/bstackLogger.js', () => ({ BStackLogger: { debug: vi.fn() } }))

import { instrumentBrowserContextHooks, getPreTestWindowFailure, getHookFailure, getActiveHookName } from '../src/hookInstrumentation.js'

describe('pre-test window failures', () => {
    beforeEach(() => {
        // the recorder is module state; clear it by re-running the hooks that write to it
        instrumentBrowserContextHooks({ before: [], beforeSuite: [] } as never)
    })

    it('records a rejection from the config-level before hook', async () => {
        const config = { before: [async () => { throw new Error('BOOM from before') }] } as never

        instrumentBrowserContextHooks(config)
        await expect((config as { before: Array<() => Promise<void>> }).before[0]()).rejects.toThrow('BOOM from before')

        expect(getHookFailure('before')).toBe('BOOM from before')
        expect(getPreTestWindowFailure()).toBe('before: BOOM from before')
    })

    it('also catches beforeSuite, which the Mocha adapter runs inside the same window', async () => {
        // registered as a root before-all by @wdio/mocha-framework, so it runs after the
        // config-level before and still ahead of the first test
        const config = { beforeSuite: [async () => { throw new Error('BOOM from beforeSuite') }] } as never

        instrumentBrowserContextHooks(config)
        await expect((config as { beforeSuite: Array<() => Promise<void>> }).beforeSuite[0]()).rejects.toThrow('BOOM from beforeSuite')

        expect(getPreTestWindowFailure()).toBe('beforeSuite: BOOM from beforeSuite')
    })

    it('keeps a synchronous handler synchronous, and still records its throw', () => {
        const config = { before: [() => { throw new Error('sync BOOM') }] } as never

        instrumentBrowserContextHooks(config)
        const handler = (config as { before: Array<() => unknown> }).before[0]

        // not a promise: an async wrapper would turn this throw into an unhandled rejection
        expect(() => handler()).toThrow('sync BOOM')
        expect(getPreTestWindowFailure()).toBe('before: sync BOOM')
    })

    it('reports nothing when the window ran clean', async () => {
        const config = { before: [async () => 'fine'] } as never

        instrumentBrowserContextHooks(config)
        await (config as { before: Array<() => Promise<unknown>> }).before[0]()

        expect(getPreTestWindowFailure()).toBeUndefined()
    })
})

describe('active hook name', () => {
    it('reports which hook is executing, and nothing once it has finished', async () => {
        const seen: Array<string | undefined> = []
        const config = {
            before: [async () => { seen.push(getActiveHookName()) }],
            beforeSuite: [async () => { seen.push(getActiveHookName()) }]
        } as never

        instrumentBrowserContextHooks(config)
        const c = config as unknown as { before: Array<() => Promise<void>>, beforeSuite: Array<() => Promise<void>> }
        await c.before[0]()
        await c.beforeSuite[0]()

        expect(seen).toEqual(['before', 'beforeSuite'])
        expect(getActiveHookName()).toBeUndefined()
    })

    it('unwinds even when the hook throws', async () => {
        const config = { before: [async () => { throw new Error('BOOM') }] } as never

        instrumentBrowserContextHooks(config)
        await expect((config as { before: Array<() => Promise<void>> }).before[0]()).rejects.toThrow('BOOM')

        expect(getActiveHookName()).toBeUndefined()
    })
})
