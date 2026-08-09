import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/fetchWrapper.js', () => ({
    _fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    default: vi.fn(async () => new Response('{}', { status: 200 }))
}))

import { stopBuildUpstream } from '../src/util.js'
import { _fetch } from '../src/fetchWrapper.js'
import { BROWSERSTACK_TESTHUB_JWT, BROWSERSTACK_KILL_SIGNAL, TESTOPS_BUILD_COMPLETED_ENV } from '../src/constants.js'

describe('stopBuildUpstream kill-signal metadata', () => {
    beforeEach(() => {
        vi.mocked(_fetch).mockClear()
        process.env[BROWSERSTACK_TESTHUB_JWT] = 'jwt'
        process.env[TESTOPS_BUILD_COMPLETED_ENV] = 'true'
    })

    afterEach(() => {
        delete process.env[BROWSERSTACK_TESTHUB_JWT]
        delete process.env[TESTOPS_BUILD_COMPLETED_ENV]
        delete process.env[BROWSERSTACK_KILL_SIGNAL]
    })

    const requestBody = () => JSON.parse((vi.mocked(_fetch).mock.calls[0][1] as RequestInit).body as string)

    it('stamps finished_metadata when the kill-signal env is set', async () => {
        process.env[BROWSERSTACK_KILL_SIGNAL] = 'SIGINT'
        await stopBuildUpstream()
        expect(requestBody().finished_metadata).toEqual([{ reason: 'user_killed', signal: 'SIGINT' }])
    })

    it('omits finished_metadata when the kill-signal env is absent', async () => {
        await stopBuildUpstream()
        expect(requestBody().finished_metadata).toBeUndefined()
    })
})
