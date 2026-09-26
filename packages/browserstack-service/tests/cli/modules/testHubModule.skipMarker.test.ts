import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import * as bstackLogger from '../../../src/bstackLogger.js'
import TestHubModule from '../../../src/cli/modules/testHubModule.js'
import TestFrameworkInstance from '../../../src/cli/instances/testFrameworkInstance.js'
import TrackedInstance from '../../../src/cli/instances/trackedInstance.js'
import { TestFrameworkState } from '../../../src/cli/states/testFrameworkState.js'
import { HookState } from '../../../src/cli/states/hookState.js'
import { TestFrameworkConstants } from '../../../src/cli/frameworks/constants/testFrameworkConstants.js'

vi.spyOn(bstackLogger.BStackLogger, 'logToFile').mockImplementation(() => {})

describe('TestHubModule skipTestHub marker', () => {
    let module: TestHubModule
    let sendTestFrameworkEvent: ReturnType<typeof vi.spyOn>
    let sendTestSessionEvent: ReturnType<typeof vi.spyOn>

    const instanceIn = (state: State, hook: State, framework = 'WebdriverIO-cucumber') => {
        const instance = new TestFrameworkInstance(TrackedInstance.createContext('t'), [framework], { [framework]: '9' }, state, hook)
        instance.updateMultipleEntries({
            [TestFrameworkConstants.KEY_TEST_FRAMEWORK_NAME]: framework,
            [TestFrameworkConstants.KEY_TEST_UUID]: 'uuid-1',
            [TestFrameworkConstants.KEY_TEST_RESULT_AT]: 'now',
        })
        return instance
    }

    beforeEach(() => {
        module = new TestHubModule({})
        sendTestFrameworkEvent = vi.spyOn(module, 'sendTestFrameworkEvent').mockResolvedValue(true)
        sendTestSessionEvent = vi.spyOn(module, 'sendTestSessionEvent').mockResolvedValue(undefined)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('handles test and hook events that carry no marker, as before', () => {
        module.onBeforeTest({ instance: instanceIn(TestFrameworkState.TEST, HookState.PRE) })
        module.onAllTestEvents({ instance: instanceIn(TestFrameworkState.TEST, HookState.PRE) })
        module.onAllTestEvents({ instance: instanceIn(TestFrameworkState.BEFORE_ALL, HookState.POST) })
        expect(sendTestSessionEvent).toHaveBeenCalledTimes(1)
        expect(sendTestFrameworkEvent).toHaveBeenCalledTimes(2)
    })

    it('ignores events marked skipTestHub', () => {
        module.onBeforeTest({ instance: instanceIn(TestFrameworkState.TEST, HookState.PRE), skipTestHub: true })
        module.onAllTestEvents({ instance: instanceIn(TestFrameworkState.TEST, HookState.POST), skipTestHub: true })
        expect(sendTestSessionEvent).not.toHaveBeenCalled()
        expect(sendTestFrameworkEvent).not.toHaveBeenCalled()
    })

    it('only honours the literal true', () => {
        module.onAllTestEvents({ instance: instanceIn(TestFrameworkState.TEST, HookState.PRE), skipTestHub: 'true' })
        expect(sendTestFrameworkEvent).toHaveBeenCalledTimes(1)
    })
})
