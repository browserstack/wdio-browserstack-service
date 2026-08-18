# @wdio/browserstack-service

## 9.34.1

### Patch Changes

- b9bb4eb: - Fixed `browserstack_executor` commands issued through `browser.execute()` or `browser.executeAsync()` being ignored in WebDriver BiDi sessions.

## 9.34.0

### Minor Changes

- aa16aa1: - The debug logs the service uploads at the end of a run now include a copy of your `wdio.conf` file (and the local config files it imports) plus your `package.json`, with values under known credential keys removed on a best-effort basis, so BrowserStack support can investigate configuration issues without asking you to reproduce them.
  - Set `disableAutoCaptureLogs: true` in the service options, or `BROWSERSTACK_DISABLE_AUTO_CAPTURE_LOGS=true`, to turn this upload off entirely.

### Patch Changes

- 69ede2a: - Fixed inflated build durations on the Test Observability dashboard for WebdriverIO + Cucumber runs: hooks interrupted mid-run are now closed instead of staying "in progress" until the hook timeout.
- f75b180: - Fixed WebdriverIO (Mocha) builds occasionally being reported as timed out even though the test run finished successfully.
- 0986e13: - Fixed App Automate and Automate session names staying on the static `sessionName` capability instead of the test title, for suites that reload the session between tests or whose run ends before the WebdriverIO `after` hook.
- 941b677: - Made the Test Reporting build-completion signal more resilient on restricted corporate networks, so builds are less likely to be left showing as "running" after a run ends.
  - Each delivery attempt is now individually time-bounded, so a hung connection can no longer stall the end of a run.
  - When the signal still cannot be delivered, the log now records the underlying network reason (for example a DNS or proxy failure) instead of a generic `fetch failed`.
- 52f0cf4: - Fixed test results not appearing in Test Reporting for WebdriverIO + Mocha when the project is not a git repository.
  - Fixed the BrowserStack binary not updating once a copy was already present, which could leave a machine on an old binary indefinitely.

## 9.33.2

### Patch Changes

- b688f05: - Fixed Accessibility Automation producing no report for WebdriverIO suites running on the jasmine framework. Accessibility scans now run for jasmine specs, as they already did for mocha.

## 9.33.1

### Patch Changes

- 4b19d7a: - Fixed App Automate session names not updating to the test title when the app is provided via the `appium:app` capability.
- 929b1f5: - Fixed WebdriverIO test results sometimes not appearing (builds staying "in progress") when the build-completion signal failed or the test runner was interrupted.

## 9.33.0

### Minor Changes

- e99828d: - Fixed SDK logs not being uploaded when a test run is interrupted (Ctrl-C or CI job cancellation); interrupted runs are now correctly reported with their termination reason.

### Patch Changes

- 74c2682: - Read the `apis` service-URL map from the binary's new `config.sessionData` bucket (SDK-6821 session.config split), with the flat `config.apis` as backward-compat fallback. Single-point change in `setConfig`; verified `npm run build` clean and the vitest suite shows zero new failures vs main (68 pre-existing environmental failures identical on both).

## 9.32.1

### Patch Changes

- aefd604: - Fixed a statically-skipped test (`it.skip`) being left orphaned as "in progress" on the Test Observability dashboard in the CLI flow. Such tests are reported from the un-awaited `onTestSkip` reporter hook, so their `TestRunFinished` event could still be pending when the worker tore down; the `after()` hook now drains these skip reports before the session closes so the test is correctly reported as skipped.
- 1a973e9: - fix: Accessibility command wrapping.
- a24973b: - Fixed Test Observability not being fully disabled for a run when the build could not be started (e.g. an unsupported framework) — such sessions no longer emit observability events or get linked to a non-existent build.
- 8539e5f: fix(a11y): restore per-command auto-scanning for App Automate accessibility sessions

  App Automate accessibility sessions were skipped by the per-command `overwriteCommand`
  wrapping in `onBeforeExecute` (guarded to `!isAppAccessibility`), so app a11y scans only
  fired via an explicit `performScan()` or the end-of-test lifecycle scan — per-command
  auto-scanning that web sessions get was effectively disabled for app. Command wrapping now
  applies to app sessions too, with each `overwriteCommand` call individually guarded so a
  command the appium driver does not register is skipped (logged at debug) instead of aborting
  `onBeforeExecute`. Commands appium does register (`click`, `setValue`, ...) now auto-scan on
  App Automate, matching the web flow.

## 9.32.0

### Minor Changes

- 9b80e47: Add a `skipAppOverride` service option for App Automate (Appium) runs. With `skipAppOverride: true` the service classifies the session as App Automate even when no `app` option is set, does not upload an app, and does not inject an `appium:app` capability — the user supplies the app reference themselves (e.g. a pre-uploaded `bs://` hash as a driver capability or via `BROWSERSTACK_APP_ID`). Setting it together with an `app` option logs a conflict warning and ignores the `app` option; `skipAppOverride: false` with no `app` fails fast with a configuration error before any session starts. Unset keeps existing behaviour unchanged.

## 9.31.0

### Minor Changes

- bebf0f1: - App Accessibility scans triggered inside test hooks (`before`/`after`, `beforeEach`/`afterEach`) are now correctly attributed to the wrapping test instead of being dropped.
- 517d64d: - Custom tags (`browser.setCustomTags`) set inside Mocha `beforeEach` / `afterEach` hooks now reliably land on the intended test's custom metadata, unioning and deduping with tags set in the test body (parity with Java `@Before` / `@After`).
- 05fe529: Custom tags (`browser.setCustomTags`) set inside Mocha `beforeEach` / `afterEach` hooks now reliably land on the intended test's custom metadata. WDIO's Mocha runner fires user hooks outside the SDK's per-test tracking span — `beforeEach` runs before the test instance is tracked and `afterEach` runs after it is finished — so tags set in those hooks previously either attached to the wrong test or were dropped from the payload.

  Tags set in `beforeEach` are now buffered and flushed onto the test at its start, and the test-finished event is deferred past the `afterEach` window so late tags still make the payload. Values set across `beforeEach`, the test body, and `afterEach` union and dedupe onto the test (parity with Java `@Before` / `@After`).

## 9.30.2

### Patch Changes

- a43e534: - Fixed skipped tests (`it.skip`, `this.skip()` in before/beforeEach hooks) and suites aborted by a failed before hook not being reported to Test Observability when using the CLI.
  - Fixed Automate sessions from skipped/aborted spec files not being linked to the Test Observability build.

## 9.30.1

### Patch Changes

- de1684b: Refresh the framework session id on `reloadSession` so Test Observability keeps linking to the correct session after a reload (#54), and declare `browser.setCustomTags` on the `WebdriverIO.Browser` type so it type-checks in consumer projects (SDK-6882, #53).

## 9.30.0

### Minor Changes

- e4cf295: Publish from the standalone `browserstack/wdio-browserstack-service` repo, at parity with the WebdriverIO monorepo. Includes Load Testing Service (LTS) support, one-to-many Test-Case-ID tagging (`setCustomTestCaseId`), correct test/hook finish on mocha timeouts, per-batch failure isolation in the request queue, accessibility Browser type augmentations, and `yauzl` upgraded to `^3.4.0`. No user-facing API change.
- 46ee119: BrowserStack now publishes `@wdio/browserstack-service` from its own repository
  (`browserstack/wdio-browserstack-service`) on an independent release cadence, using npm OIDC
  trusted publishing. No change for end users — same package name and the same
  `services: ['browserstack']` configuration continue to work unchanged.

### Patch Changes

- 7306121: Declare `webdriverio` as a dependency instead of a peerDependency, matching the package published from the WebdriverIO monorepo. The extraction had moved `webdriverio` into `peerDependencies` (`^9.0.0`); npm then forced the consumer's `webdriverio` to `^9`, which conflicts with any project that also depends on a package peering `webdriverio@"^7 || ^8"` (e.g. `wdio-chromedriver-service@^8`) and surfaced as an `npm ERESOLVE` on install — a failure the monorepo-published package never had. Restores install parity with the upstream package; no user-facing API change.
- 7d6f822: Port the 2026-07-10 monorepo accessibility/CLI fixes to keep the standalone at parity (webdriverio/webdriverio#15380, #15383, #15382, #15381, #15376): skip the accessibility scan for BiDi `window`/`context` commands, route WDIO CLI-flow App Automate sessions to app-accessibility, finalize orphaned test runs on an interrupted exit, coerce stringified boolean accessibility options, and report mocha hooks in the CLI/testHub flow. No user-facing API change.
