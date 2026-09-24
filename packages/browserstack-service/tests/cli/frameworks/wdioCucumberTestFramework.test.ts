import path from 'node:path'
import { describe, expect, it, beforeEach, vi } from 'vitest'

import WdioCucumberTestFramework from '../../../src/cli/frameworks/wdioCucumberTestFramework.js'
import TestFramework from '../../../src/cli/frameworks/testFramework.js'
import { TestFrameworkState } from '../../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../../src/cli/states/hookState.js'
import { TestFrameworkConstants } from '../../../src/cli/frameworks/constants/testFrameworkConstants.js'
import type TestFrameworkInstance from '../../../src/cli/instances/testFrameworkInstance.js'

vi.mock('../../../src/bstackLogger.js')

const FEATURE_URI = '/abs/project/features/login.feature'

const feature = (children: unknown[] = []) => ({
    name: 'Login feature',
    description: 'Login feature description',
    children,
} as any)

const pickle = (name: string, tags: string[] = [], astNodeIds: string[] = ['scenario-1']) => ({
    name,
    uri: 'features/login.feature',
    astNodeIds,
    tags: tags.map(t => ({ name: t })),
} as any)

const world = (p: any, f: any, result?: any) => ({
    pickle: p,
    gherkinDocument: { uri: 'features/login.feature', feature: f },
    result,
} as any)

const step = (id: string, text = 'I do a thing', keyword = 'Given ') => ({ id, text, keyword } as any)

const newFramework = () => new WdioCucumberTestFramework(['WebdriverIO-cucumber'], { 'WebdriverIO-cucumber': '8.50.0' }, 'bin-session')

const liveInstance = () => TestFramework.getTrackedInstance() as TestFrameworkInstance
const dataOf = (instance: TestFrameworkInstance) => Object.fromEntries(instance.getAllData())

describe('WdioCucumberTestFramework', () => {
    let framework: WdioCucumberTestFramework

    beforeEach(() => {
        TestFramework.instances.clear()
        framework = newFramework()
    })

    describe('hook classification (state machine, never a title)', () => {
        it('classifies an absent hook object as BEFORE_ALL before any scenario and AFTER_ALL after one', async () => {
            framework.onFeatureStart(FEATURE_URI, feature())
            expect(framework.classifyHookType(undefined)).toBe('BEFORE_ALL')

            await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { world: world(pickle('S'), feature()) })
            expect(framework.classifyHookType(undefined)).toBe('AFTER_ALL')
        })

        it('classifies a hook object as BEFORE_EACH before the first step and AFTER_EACH after the last', async () => {
            framework.onFeatureStart(FEATURE_URI, feature())
            await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { world: world(pickle('S'), feature()) })

            expect(framework.classifyHookType({ id: 'h', hookId: 'h1' } as any)).toBe('BEFORE_EACH')

            framework.onStepStart(step('s1'))
            framework.onStepEnd(step('s1'), { passed: true } as any)
            expect(framework.classifyHookType({ id: 'h', hookId: 'h1' } as any)).toBe('AFTER_EACH')
        })

        it('classifies a step-scoped hook as null so it is never reported', async () => {
            framework.onFeatureStart(FEATURE_URI, feature())
            await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { world: world(pickle('S'), feature()) })

            framework.onStepStart(step('s1'))
            expect(framework.classifyHookType({ id: 'h', hookId: 'h1' } as any)).toBeNull()
            expect(framework.classifyHookState({ id: 'h', hookId: 'h1' } as any)).toBeNull()
        })

        // PB-V8-1: legacy never resets _cucumberData.steps per scenario, so one missed afterStep
        // silently drops every later AFTER_EACH. Reproducing it is parity; the v9 line resets.
        it('does NOT reset the step depth per scenario, so a missed step end poisons later AFTER_EACH', async () => {
            framework.onFeatureStart(FEATURE_URI, feature())
            await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { world: world(pickle('S1'), feature()) })
            framework.onStepStart(step('s1'))
            // no onStepEnd — the step never completed

            await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { world: world(pickle('S2'), feature()) })
            framework.onStepStart(step('s2'))
            framework.onStepEnd(step('s2'), { passed: true } as any)

            expect(framework.classifyHookType({ id: 'h', hookId: 'h1' } as any)).toBeNull()
        })
    })

    describe('scenario identity', () => {
        it('keeps test_id raw while name and scope carry the examples qualifier', async () => {
            const outlineFeature = feature([{
                scenario: {
                    id: 'scenario-1',
                    examples: [{ tableBody: [{ id: 'row-1', cells: [{ value: 'alpha' }, { value: 'one' }] }] }],
                },
            }])
            framework.onFeatureStart(FEATURE_URI, outlineFeature)
            await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, {
                world: world(pickle('Add to cart', [], ['scenario-1', 'row-1']), outlineFeature),
            })

            const data = dataOf(liveInstance())
            expect(data[TestFrameworkConstants.KEY_TEST_NAME]).toBe('Add to cart (alpha, one)')
            expect(data[TestFrameworkConstants.KEY_TEST_SCOPE]).toBe('Add to cart (alpha, one)')
            expect(data[TestFrameworkConstants.KEY_TEST_ID]).toBe('Add to cart')
        })

        it('reports a one-element scopes array, a null test_code and the meta feature path cwd-relative', async () => {
            framework.onFeatureStart(FEATURE_URI, feature())
            await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { world: world(pickle('Add to cart'), feature()) })

            const data = dataOf(liveInstance()) as Record<string, any>
            expect(data[TestFrameworkConstants.KEY_TEST_SCOPES]).toEqual(['Login feature'])
            expect(data[TestFrameworkConstants.KEY_TEST_CODE]).toBeNull()
            // The binary re-bases test_file_path/location but never this blob, so an absolute value
            // would reach the dashboard verbatim, home directory and all.
            expect(data.bdd_meta_info.feature.path).toBe(path.relative(process.cwd(), FEATURE_URI))
            expect(path.isAbsolute(data.bdd_meta_info.feature.path)).toBe(false)
            // the file-path pair stays absolute — the binary owns re-basing those
            expect(data[TestFrameworkConstants.KEY_TEST_FILE_PATH]).toBe(FEATURE_URI)
        })

        it('sends tags with the leading @, in source order, duplicates kept, without mutating the pickle', async () => {
            const p = pickle('Add to cart', ['@smoke', '@smoke', '@regression'])
            framework.onFeatureStart(FEATURE_URI, feature())
            await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { world: world(p, feature()) })

            expect(dataOf(liveInstance())[TestFrameworkConstants.KEY_TEST_TAGS]).toEqual(['@smoke', '@smoke', '@regression'])
            expect(p.tags).toEqual([{ name: '@smoke' }, { name: '@smoke' }, { name: '@regression' }])
        })
    })

    describe('scenario result', () => {
        const finish = async (fw: WdioCucumberTestFramework, result: any, args: Record<string, unknown> = {}) => {
            fw.onFeatureStart(FEATURE_URI, feature())
            await fw.trackEvent(TestFrameworkState.TEST, HookState.PRE, { world: world(pickle('S'), feature()) })
            const instance = liveInstance()
            await fw.trackEvent(TestFrameworkState.TEST, HookState.POST, { world: world(pickle('S'), feature(), result), ...args })
            return dataOf(instance) as Record<string, any>
        }

        it('collapses every non passed/failed status to skipped and stamps the result timestamp', async () => {
            const data = await finish(framework, { status: 'UNDEFINED', duration: { seconds: 1, nanos: 500000000 } })
            expect(data[TestFrameworkConstants.KEY_TEST_RESULT]).toBe('skipped')
            expect(data[TestFrameworkConstants.KEY_TEST_RESULT_AT]).toBeTruthy()
        })

        it("derives test_duration from cucumber's Duration, not from the timestamp delta", async () => {
            const data = await finish(framework, { status: 'PASSED', duration: { seconds: 2, nanos: 250000000 } })
            expect(data.test_duration).toBe(2250)
        })

        it('reports a one-element backtrace and the AssertionError failure type', async () => {
            const data = await finish(framework, { status: 'FAILED', message: 'AssertionError: nope', duration: { seconds: 0, nanos: 0 } })
            expect(data[TestFrameworkConstants.KEY_TEST_FAILURE]).toEqual([{ backtrace: ['AssertionError: nope'] }])
            expect(data[TestFrameworkConstants.KEY_TEST_FAILURE_TYPE]).toBe('AssertionError')
        })

        it('overrides a hook-only failure to passed only when ignoreHooksStatus is declared', async () => {
            const failed = { status: 'FAILED', message: 'boom', duration: { seconds: 0, nanos: 0 } }

            const overridden = await finish(newFramework(), failed, { ignoreHooksStatus: true, hasStepFailures: false })
            expect(overridden[TestFrameworkConstants.KEY_TEST_RESULT]).toBe('passed')

            TestFramework.instances.clear()
            const notOverridden = await finish(newFramework(), failed, { ignoreHooksStatus: true, hasStepFailures: true })
            expect(notOverridden[TestFrameworkConstants.KEY_TEST_RESULT]).toBe('failed')
        })
    })

    describe('hook lifecycle', () => {
        const openScenario = async () => {
            framework.onFeatureStart(FEATURE_URI, feature())
            await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { world: world(pickle('Add to cart'), feature()) })
            return liveInstance()
        }

        it('names the hook after the scenario for EACH and the feature for ALL, and scopes both to the feature', async () => {
            const instance = await openScenario()
            await framework.trackEvent(TestFrameworkState.BEFORE_EACH, HookState.PRE, { test: { id: 'h', hookId: 'h1' } })

            const started = dataOf(instance)[TestFrameworkConstants.KEY_HOOKS_STARTED] as Map<string, any[]>
            const hook = started.get('BEFORE_EACH')![0]
            expect(hook[TestFrameworkConstants.KEY_HOOK_NAME]).toBe('BEFORE_EACH for Add to cart')
            expect(hook.hook_scope).toBe('Login feature')
            expect(hook.test_file_path).toBe(FEATURE_URI)
            expect(hook[TestFrameworkConstants.KEY_TEST_TAGS]).toBeUndefined()
        })

        it('records passed/failed on the finish rather than leaving hook_result pending', async () => {
            const instance = await openScenario()
            await framework.trackEvent(TestFrameworkState.BEFORE_EACH, HookState.PRE, { test: { id: 'h', hookId: 'h1' } })
            await framework.trackEvent(TestFrameworkState.BEFORE_EACH, HookState.POST, {
                test: { id: 'h', hookId: 'h1' },
                result: { passed: false, duration: 12, retries: { attempts: 0, limit: 0 } },
            })

            const finished = dataOf(instance)[TestFrameworkConstants.KEY_HOOKS_FINISHED] as Map<string, any[]>
            const hook = finished.get('BEFORE_EACH')![0]
            expect(hook[TestFrameworkConstants.KEY_HOOK_RESULT]).toBe('failed')
            expect(hook.hook_duration).toBe(12)
            expect(hook.hook_retries).toEqual({ attempts: 0, limit: 0 })
        })

        it('drops an orphaned hook finish and suppresses the cascade that would have followed it', async () => {
            const instance = await openScenario()
            await framework.trackEvent(TestFrameworkState.BEFORE_ALL, HookState.POST, {
                test: undefined,
                result: { passed: false },
            })

            const finished = dataOf(instance)[TestFrameworkConstants.KEY_HOOKS_FINISHED] as Map<string, any[]>
            expect(finished.get('BEFORE_ALL')).toEqual([])
            expect(framework.shouldCascadeSkippedScenarios()).toBe(false)
        })
    })

    describe('BEFORE_ALL skip cascade', () => {
        it('builds one detached instance per scenario, Rule-nested rows included', () => {
            const cascadeFeature = feature([
                { scenario: { name: 'Plain one', steps: [step('s1')] } },
                { rule: { children: [{ scenario: { name: 'Rule nested', steps: [step('s2')] } }] } },
            ])
            framework.onFeatureStart(FEATURE_URI, cascadeFeature)

            const instances = framework.buildSkippedScenarioInstances()
            expect(instances.map(i => dataOf(i)[TestFrameworkConstants.KEY_TEST_NAME])).toEqual(['Plain one', 'Rule nested'])

            const first = dataOf(instances[0]) as Record<string, any>
            expect(first[TestFrameworkConstants.KEY_TEST_ID]).toBe('Plain one')
            expect(first[TestFrameworkConstants.KEY_TEST_SCOPE]).toBe('Plain one')
            expect(first[TestFrameworkConstants.KEY_TEST_RESULT]).toBe('skipped')
            expect(first.test_skipped_cascade).toBe(true)
            expect(first[TestFrameworkConstants.KEY_TEST_TAGS]).toBeUndefined()
            expect(first.bdd_meta_info.steps).toEqual([{ id: 's1', text: 'I do a thing', keyword: 'Given ', result: 'skipped' }])
            // the cascade builds its own meta blob, so it needs the same relative/absolute split
            expect(first.bdd_meta_info.feature.path).toBe(path.relative(process.cwd(), FEATURE_URI))
            expect(first[TestFrameworkConstants.KEY_TEST_FILE_PATH]).toBe(FEATURE_URI)

            // Detached: the live tracked instance is untouched.
            expect(TestFramework.getTrackedInstance()).toBeUndefined()
        })
    })

    describe('log routing', () => {
        it('stamps the open hook uuid while a hook is unfinished and the test uuid otherwise', async () => {
            framework.onFeatureStart(FEATURE_URI, feature())
            await framework.trackEvent(TestFrameworkState.TEST, HookState.PRE, { world: world(pickle('S'), feature()) })
            const instance = liveInstance()

            await framework.trackEvent(TestFrameworkState.BEFORE_EACH, HookState.PRE, { test: { id: 'h', hookId: 'h1' } })
            await framework.trackEvent(TestFrameworkState.LOG, HookState.POST, {
                logEntry: { level: 'INFO', message: 'inside the hook', timestamp: 'now' },
            })
            await framework.trackEvent(TestFrameworkState.BEFORE_EACH, HookState.POST, {
                test: { id: 'h', hookId: 'h1' }, result: { passed: true },
            })
            await framework.trackEvent(TestFrameworkState.LOG, HookState.POST, {
                logEntry: { level: 'INFO', message: 'inside the step', timestamp: 'now', kind: TestFrameworkConstants.KIND_SCREENSHOT },
            })

            const logs = dataOf(instance)[TestFrameworkConstants.KEY_TEST_LOGS] as Record<string, unknown>[]
            expect(logs[0][TestFrameworkConstants.KEY_HOOK_ID]).toBeTruthy()
            expect(logs[0].kind).toBe(TestFrameworkConstants.KIND_LOG)
            expect(logs[1][TestFrameworkConstants.KEY_HOOK_ID]).toBeUndefined()
            // SDK-6277: an incoming screenshot kind must survive rather than be flattened to a log.
            expect(logs[1].kind).toBe(TestFrameworkConstants.KIND_SCREENSHOT)
        })
    })
})
