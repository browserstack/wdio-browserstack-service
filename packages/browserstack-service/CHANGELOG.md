# @wdio/browserstack-service

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
