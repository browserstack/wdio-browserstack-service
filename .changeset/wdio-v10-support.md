---
"@wdio/browserstack-service": minor
---

Support WebdriverIO 10. WebdriverIO 9 stays supported.

- Multiremote sessions use `isMultiRemote` (v10) or `isMultiremote` (v9), and get each instance with `getInstance()`.
- Accessibility command wrapping passes `{ attachToElement: true }` to `overwriteCommand`, which works in v9 and v10.
- The CLI accessibility scripts run through `execute()`, because v10 removed `executeAsync()`.
- The BiDi `browserstack_executor` routing patches `executeAsync` only when the command exists (v9).
- On WebdriverIO 10 with Mocha, the tests that a failed `before` or `beforeEach` hook skipped are reported as failed with the hook error, as WebdriverIO 10 reports them. With `mochaOpts.failHookAffectedTests: false`, they stay skipped.
- On WebdriverIO 10, App Automate sessions that do not set an Appium version get `bstack:options.appiumVersion: '3.3.0'`. App Automate uses Appium 1.22.0 by default, and WebdriverIO 10 supports Appium 3 only.
