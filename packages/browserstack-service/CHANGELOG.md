# @wdio/browserstack-service

## 8.49.2

### Patch Changes

- effdc1e: - Fixed SDK logs not being uploaded when a test run is interrupted (Ctrl-C or CI job cancellation); interrupted runs are now reported with their termination reason on the build record.

## 8.49.1

### Patch Changes

- 6073bcc: Fixed skipped tests (it.skip, this.skip() in before/beforeEach hooks) and suites aborted by a failed before hook not being reported to Test Observability when using the CLI. Fixed Automate sessions from skipped/aborted spec files not being linked to the Test Observability build. Fixed hook results not appearing on the dashboard and a failed before hook not failing the build.

## 8.49.0

### Minor Changes

- 46ee119: BrowserStack now publishes `@wdio/browserstack-service` from its own repository
  (`browserstack/wdio-browserstack-service`) on an independent release cadence, using npm OIDC
  trusted publishing. No change for end users — same package name and the same
  `services: ['browserstack']` configuration continue to work unchanged.

### Patch Changes

- f78d091: Declare `webdriverio` as a dependency instead of a peerDependency, matching the v8 package published from the WebdriverIO monorepo (`@wdio/browserstack-service@8.48.3` keeps `webdriverio` in `dependencies` at `8.46.0`, peering only `@wdio/cli`). The extraction had moved it into `peerDependencies` (`^8.0.0`), which forces the consumer's `webdriverio` and can `npm ERESOLVE` against a dep peering a non-overlapping `webdriverio` range. Restores install parity with the upstream v8 package; no user-facing API change.
- 29be3ed: Port SDK-6277 (upstream webdriverio/webdriverio#15330): in the CLI/binary (v8) flow, forward screenshot-on-failure to the binary over gRPC as a `TEST_SCREENSHOT` log (the binary uploads it via its own authorized testhub session) instead of the direct-HTTP `onScreenshot` path, which 401s under the worker's binary-issued JWT. Also registers the command/result listeners in CLI mode so the user's `saveScreenshot()`/`takeScreenshot()` result is captured, and honors the incoming log `kind` in the mocha CLI framework so screenshots route correctly. Keeps the standalone v8 line at parity with the monorepo.
- cc229fe: Port missing upstream monorepo (webdriverio/webdriverio) v8 commits to keep the standalone v8 line at parity:

  - webdriverio/webdriverio#15231 — Test Management: add `testManagementOptions.testPlanId` support (env `BROWSERSTACK_TEST_PLAN_ID` / `--browserstack.testManagementOptions.testPlanId` CLI arg / config), forward `test_management.test_plan_id` in the build-start request, strip CLI-only caps (`NOT_ALLOWED_KEYS_IN_CAPS`, incl. `testManagementOptions`) before hitting the hub, and surface build-start errors.
  - webdriverio/webdriverio#15217 — gRPC: raise the send/receive message size limit to 20 MB to accommodate large extension payloads.
  - webdriverio/webdriverio#15146 — Exit handling: terminate the CLI process with `SIGINT` instead of `SIGKILL` on Unix.
  - webdriverio/webdriverio#15200 — Logging: redact credentials (username/accesskey/user/key) from CLI log output before writing to file and console.
