---
"@wdio/browserstack-service": minor
---

Custom tags (`browser.setCustomTags`) set inside Mocha `beforeEach` / `afterEach` hooks now reliably land on the intended test's custom metadata. WDIO's Mocha runner fires user hooks outside the SDK's per-test tracking span — `beforeEach` runs before the test instance is tracked and `afterEach` runs after it is finished — so tags set in those hooks previously either attached to the wrong test or were dropped from the payload.

Tags set in `beforeEach` are now buffered and flushed onto the test at its start, and the test-finished event is deferred past the `afterEach` window so late tags still make the payload. Values set across `beforeEach`, the test body, and `afterEach` union and dedupe onto the test (parity with Java `@Before` / `@After`).
