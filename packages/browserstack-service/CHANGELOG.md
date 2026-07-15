# @wdio/browserstack-service

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
