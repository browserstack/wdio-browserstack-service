---
"@wdio/browserstack-service": minor
---

Support WebdriverIO 10. WebdriverIO 9 stays supported.

- Multiremote sessions use `isMultiRemote` (v10) or `isMultiremote` (v9), and get each instance with `getInstance()`.
- Accessibility command wrapping passes `{ attachToElement: true }` to `overwriteCommand`, which works in v9 and v10.
- The CLI accessibility scripts run through `execute()`, because v10 removed `executeAsync()`.
- The BiDi `browserstack_executor` routing patches `executeAsync` only when the command exists (v9).
- On WebdriverIO 10 with Mocha, the tests that a failed `before` or `beforeEach` hook skipped are reported as failed with the hook error, as WebdriverIO 10 reports them. With `mochaOpts.failHookAffectedTests: false`, they stay skipped.
- On WebdriverIO 10, `execute` on a browsing context (from `browser.url()` or `browser.newWindow()`) also sends `browserstack_executor` scripts through the classic endpoint, and the accessibility auto-scan also runs before the browser commands of a browsing context, on that context.
- The CLI accessibility command wrapper no longer runs a failed command a second time. The error (for example a WebdriverIO 10 `StrictSelectorError`) goes to the test, and the service does not log it as its own error.
- On WebdriverIO 10, App Automate sessions that do not set an Appium version get `bstack:options.appiumVersion: '3.3.0'` (`browserstack.appium_version` for capabilities in the legacy format). App Automate uses Appium 1.22.0 by default, and WebdriverIO 10 supports Appium 3 only.
