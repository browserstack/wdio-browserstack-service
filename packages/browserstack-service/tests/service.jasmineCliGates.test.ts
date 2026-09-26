import path from 'node:path'

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import BrowserstackService from '../src/service.js'
import InsightsHandler from '../src/insights-handler.js'
import * as utils from '../src/util.js'
import * as skipReporter from '../src/cli/skipReporter.js'
import { BrowserstackCLI } from '../src/cli/index.js'
import * as bstackLogger from '../src/bstackLogger.js'
import { TestFrameworkState } from '../src/cli/states/testFrameworkState.js'
import { HookState } from '../src/cli/states/hookState.js'
import { TESTOPS_SCREENSHOT_ENV } from '../src/constants.js'
import TestFramework from '../src/cli/frameworks/testFramework.js'

vi.mock('fetch')
vi.mock('@wdio/logger', () => import(path.join(process.cwd(), '__mocks__', '@wdio/logger')))
vi.mock('uuid', () => ({ v4: () => '123456789' }))
vi.mock('../src/data-store.js', () => ({ saveWorkerData: vi.fn() }))
vi.mock('../src/instrumentation/performance/performance-tester.js', () => ({
    default: {
        start: vi.fn(),
        end: vi.fn(),
        startMonitoring: vi.fn(),
        measureWrapper: vi.fn().mockImplementation((_name: string, fn: Function) => fn),
        Measure: vi.fn().mockImplementation(() => (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) => descriptor),
        browser: undefined,
        scenarioThatRan: [],
    }
}))
vi.mock('../src/cli/index.js', () => ({
    BrowserstackCLI: {
        getInstance: () => ({
            isRunning: () => false,
            getTestFramework: () => null,
            getAutomationFramework: () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) })
        })
    }
}))

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

// What WDIO hands a jasmine hook: a copy of the last started spec (no `title`), then the hookName.
const lastSpec = { description: 'outer passing test', fullName: 'Nested outer outer passing test', file: '/p/nested.spec.js' } as any
const mochaHook = (title: string) => ({ title, ctx: { test: { parent: { title: 'suite', tests: [], suites: [] } } } }) as any

let getInstanceSpy: ReturnType<typeof vi.spyOn> | undefined

const cliWith = (framework: unknown) => {
    getInstanceSpy = vi.spyOn(BrowserstackCLI, 'getInstance').mockReturnValue({
        isRunning: () => true,
        getTestFramework: () => framework,
        getAutomationFramework: () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) })
    } as any)
}

const makeService = (framework: string) => new BrowserstackService({} as any, [] as any, { user: 'foo', key: 'bar', framework } as any)

afterEach(() => {
    getInstanceSpy?.mockRestore()
    getInstanceSpy = undefined
})

describe('service hooks on the CLI flow (S4)', () => {
    it('classifies jasmine hooks by hookName, without touching the missing title', async () => {
        const trackEvent = vi.fn().mockResolvedValue(undefined)
        cliWith({ trackEvent })
        const getHookTypeSpy = vi.spyOn(utils, 'getHookType')
        const service = makeService('jasmine')

        for (const hookName of ['beforeAll', 'beforeEach']) {
            await service.beforeHook(lastSpec, {}, hookName)
        }
        for (const hookName of ['afterEach', 'afterAll']) {
            await service.afterHook(lastSpec, {}, { passed: true } as any, hookName)
        }

        expect(getHookTypeSpy).not.toHaveBeenCalled()
        expect(trackEvent.mock.calls.map(([state, hook]) => [state, hook])).toEqual([
            [TestFrameworkState.BEFORE_ALL, HookState.PRE],
            [TestFrameworkState.BEFORE_EACH, HookState.PRE],
            [TestFrameworkState.AFTER_EACH, HookState.POST],
            [TestFrameworkState.AFTER_ALL, HookState.POST],
        ])
        getHookTypeSpy.mockRestore()
    })

    it('sends nothing for a jasmine hook without a hookName, and does not throw', async () => {
        const trackEvent = vi.fn().mockResolvedValue(undefined)
        cliWith({ trackEvent })
        const service = makeService('jasmine')

        await expect(service.beforeHook({} as any, {})).resolves.toBeUndefined()
        await expect(service.afterHook({} as any, {}, { passed: true } as any)).resolves.toBeUndefined()
        expect(trackEvent).not.toHaveBeenCalled()
    })

    it('never runs the mocha skip cascade for a failed jasmine hook, but still records the hook failure', async () => {
        cliWith({ trackEvent: vi.fn().mockResolvedValue(undefined) })
        const cascade = vi.spyOn(skipReporter, 'reportSuiteSkipped').mockResolvedValue(undefined as any)
        const service = makeService('jasmine')

        await service.afterHook({ ...lastSpec, ctx: { test: { parent: {} } } }, {}, { passed: false, error: new Error('beforeAll failed') } as any, 'beforeAll')

        expect(cascade).not.toHaveBeenCalled()
        expect(service['_hookFailReasons']).toEqual(['beforeAll failed'])
        cascade.mockRestore()
    })

    it('keeps mocha on its title classification and skip cascade', async () => {
        const trackEvent = vi.fn().mockResolvedValue(undefined)
        cliWith({ trackEvent })
        const cascade = vi.spyOn(skipReporter, 'reportSuiteSkipped').mockResolvedValue(undefined as any)
        const service = makeService('mocha')

        await service.beforeHook(mochaHook('"before each" hook for "t"'), {}, 'beforeEach')
        await service.afterHook(mochaHook('"before all" hook for "t"'), {}, { passed: false, error: new Error('x') } as any, 'afterAll')

        expect(trackEvent.mock.calls.map(([state, hook]) => [state, hook])).toEqual([
            [TestFrameworkState.BEFORE_EACH, HookState.PRE],
            [TestFrameworkState.BEFORE_ALL, HookState.POST],
        ])
        expect(cascade).toHaveBeenCalledTimes(1)
        cascade.mockRestore()
    })
})

describe('service.beforeTest on the CLI flow (S5)', () => {
    const runBeforeTest = async (framework: string, test: Record<string, unknown>) => {
        const trackEvent = vi.fn().mockResolvedValue(undefined)
        cliWith({ trackEvent })
        const service = makeService(framework)
        const annotate = vi.spyOn(service as any, '_setAnnotation').mockResolvedValue(undefined)
        const getState = vi.spyOn(TestFramework, 'getState').mockReturnValue('spec-uuid')
        await service.beforeTest(test as any)
        getState.mockRestore()
        return { annotate, trackEvent }
    }

    it('annotates each jasmine spec with its full name, before the modules see TEST/PRE', async () => {
        const { annotate, trackEvent } = await runBeforeTest('jasmine', lastSpec)
        expect(annotate).toHaveBeenCalledWith('Test: Nested outer outer passing test')
        const testPre = trackEvent.mock.calls.findIndex(([state]) => state === TestFrameworkState.TEST)
        expect(annotate.mock.invocationCallOrder[0]).toBeLessThan(trackEvent.mock.invocationCallOrder[testPre])
    })

    it('does not annotate mocha tests on the CLI flow', async () => {
        const { annotate } = await runBeforeTest('mocha', { title: 't', parent: 'suite' })
        expect(annotate).not.toHaveBeenCalled()
    })
})

describe('service.before on the CLI flow (S6)', () => {
    const registeredEvents = async (framework: string) => {
        process.env.BROWSERSTACK_OBSERVABILITY = 'true'
        cliWith(null)
        const browser = { on: vi.fn(), sessionId: 's1', capabilities: {}, config: {}, execute: vi.fn(), executeScript: vi.fn() } as any
        const service = new BrowserstackService({} as any, [{}] as any, { user: 'foo', key: 'bar', framework, capabilities: {} } as any)
        await service.before(service['_config'] as any, [], browser)
        delete process.env.BROWSERSTACK_OBSERVABILITY
        return vi.mocked(browser.on).mock.calls.map(([event]: [string]) => event)
    }

    it('registers command and result for jasmine', async () => {
        const events = await registeredEvents('jasmine')
        expect(events).toContain('command')
        expect(events).toContain('result')
    })

    it.each(['mocha', 'cucumber'])('keeps %s on result only', async (framework) => {
        const events = await registeredEvents(framework)
        expect(events).toContain('result')
        expect(events).not.toContain('command')
    })
})

describe('insights-handler.browserCommand on the CLI flow (S6)', () => {
    const browser = { on: vi.fn(), sessionId: 's', capabilities: {}, config: {}, execute: vi.fn() } as any
    const command = { sessionId: 's', method: 'GET', endpoint: '/session/:sessionId/title', body: {} }
    const result = { ...command, result: { value: 'StackDemo' } }

    const handlerFor = (framework: string) => {
        const handler = new InsightsHandler(browser, framework)
        handler['getIdentifier'] = vi.fn().mockReturnValue('Nested outer outer passing test')
        handler['_tests'] = { 'Nested outer outer passing test': { uuid: 'spec-uuid' } }
        return handler
    }

    beforeEach(() => {
        delete process.env[TESTOPS_SCREENSHOT_ENV]
    })

    it('sends the HTTP log over gRPC to the named spec, never to the legacy listener', async () => {
        const trackEvent = vi.fn().mockResolvedValue(undefined)
        cliWith({ trackEvent })
        const handler = handlerFor('jasmine')
        const logCreated = vi.spyOn(handler['listener'], 'logCreated').mockImplementation(() => {})

        await handler.browserCommand('client:beforeCommand', { ...command } as any, lastSpec)
        await handler.browserCommand('client:afterCommand', { ...result } as any, lastSpec)

        expect(logCreated).not.toHaveBeenCalled()
        expect(trackEvent).toHaveBeenCalledTimes(1)
        const [state, hook, { logEntry }] = trackEvent.mock.calls[0]
        expect([state, hook]).toEqual([TestFrameworkState.LOG, HookState.POST])
        expect(logEntry.kind).toBe('HTTP')
        expect(logEntry.test_run_uuid).toBe('spec-uuid')
        expect(JSON.parse(logEntry.message)).toEqual({ path: '/session/:sessionId/title', method: 'GET', body: {}, response: { value: 'StackDemo' } })
    })

    it('keeps the legacy HTTP log shape on the listener when the CLI is not running', async () => {
        const handler = handlerFor('jasmine')
        const logCreated = vi.spyOn(handler['listener'], 'logCreated').mockImplementation(() => {})

        await handler.browserCommand('client:beforeCommand', { ...command } as any, lastSpec)
        await handler.browserCommand('client:afterCommand', { ...result } as any, lastSpec)

        expect(logCreated).toHaveBeenCalledWith([{
            test_run_uuid: 'spec-uuid',
            timestamp: expect.any(String),
            kind: 'HTTP',
            http_response: { path: '/session/:sessionId/title', method: 'GET', body: {}, response: { value: 'StackDemo' } }
        }])
    })

    it('names the spec on a jasmine screenshot, and leaves the mocha screenshot entry unchanged', async () => {
        process.env[TESTOPS_SCREENSHOT_ENV] = 'true'
        const screenshot = { sessionId: 's', method: 'GET', endpoint: '/session/:sessionId/screenshot', result: { value: 'b64' } }

        const jasmineTrack = vi.fn().mockResolvedValue(undefined)
        cliWith({ trackEvent: jasmineTrack })
        await handlerFor('jasmine').browserCommand('client:afterCommand', { ...screenshot } as any, lastSpec)
        getInstanceSpy!.mockRestore()

        const mochaTrack = vi.fn().mockResolvedValue(undefined)
        cliWith({ trackEvent: mochaTrack })
        await handlerFor('mocha').browserCommand('client:afterCommand', { ...screenshot } as any, { title: 't' } as any)

        expect(jasmineTrack.mock.calls[0][2].logEntry).toEqual({ kind: 'TEST_SCREENSHOT', message: 'b64', timestamp: expect.any(String), test_run_uuid: 'spec-uuid' })
        expect(Object.keys(mochaTrack.mock.calls[0][2].logEntry)).toEqual(['kind', 'message', 'timestamp'])
    })

    it('drops commands with no spec yet, as legacy did before the first spec', async () => {
        const trackEvent = vi.fn().mockResolvedValue(undefined)
        cliWith({ trackEvent })
        const handler = handlerFor('jasmine')
        handler['getIdentifier'] = vi.fn().mockReturnValue(undefined)

        await handler.browserCommand('client:beforeCommand', { ...command } as any, {} as any)
        await handler.browserCommand('client:afterCommand', { ...result } as any, {} as any)

        expect(trackEvent).not.toHaveBeenCalled()
    })
})
