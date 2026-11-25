---
"@wdio/browserstack-service": patch
---

- Fixed Mocha tests that fail because of a failed `before`/`beforeEach` hook showing as skipped in Test Reporting. They are now reported as failed with the hook's error, matching Mocha's `failHookAffectedTests` (on by default in WebdriverIO 10).
