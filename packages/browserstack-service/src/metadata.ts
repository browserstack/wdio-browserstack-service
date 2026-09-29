import { BStackLogger } from './bstackLogger.js'
import { getCentralUser } from './util.js'

type Metadata = Record<string, any>

class TestMetadata {
    private static currentTestRunUuid?: string
    private static metadataByTestRunUuid: Record<string, Metadata> = {}
    private static fallbackMetadata: Metadata = {}

    static setCurrentTestRunUuid(testRunUuid?: string) {
        TestMetadata.currentTestRunUuid = testRunUuid
    }

    static set(metadata: Metadata = {}) {
        if (!getCentralUser().app_lcnc) {
            BStackLogger.warn(`setTestMetadata: ignored, BROWSERSTACK_CENTRAL_USER=${process.env.BROWSERSTACK_CENTRAL_USER}`)
            return
        }

        const testRunIdentifier = metadata.identifier
        if (typeof testRunIdentifier !== 'string' || testRunIdentifier.length === 0) {
            BStackLogger.warn('setTestMetadata: metadata.identifier must be a non-empty string.')
            return
        }
        if (testRunIdentifier.length > 40) {
            BStackLogger.warn(`setTestMetadata: identifier "${testRunIdentifier}" exceeds the 40-character limit.`)
            return
        }
        TestMetadata.fallbackMetadata = metadata

        if (TestMetadata.currentTestRunUuid) {
            TestMetadata.metadataByTestRunUuid[TestMetadata.currentTestRunUuid] = metadata
        }
        BStackLogger.debug(`setTestMetadata: identifier=${testRunIdentifier} storedUnderUuid=${TestMetadata.currentTestRunUuid} store=[${Object.keys(TestMetadata.metadataByTestRunUuid)}]`)
    }

    static get(testRunUuid?: string): Metadata {
        if (!getCentralUser().app_lcnc) {
            return {}
        }

        if (testRunUuid) {
            const metadata = TestMetadata.metadataByTestRunUuid[testRunUuid] || TestMetadata.fallbackMetadata || {}
            BStackLogger.debug(`TestMetadata.get: uuid=${testRunUuid} identifier=${metadata.identifier} store=[${Object.keys(TestMetadata.metadataByTestRunUuid)}]`)
            return metadata
        }

        return TestMetadata.fallbackMetadata || {}
    }

    static reset() {
        TestMetadata.currentTestRunUuid = undefined
        TestMetadata.metadataByTestRunUuid = {}
        TestMetadata.fallbackMetadata = {}
    }
}

export default TestMetadata
