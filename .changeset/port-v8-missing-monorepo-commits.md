---
"@wdio/browserstack-service": patch
---

Port missing upstream monorepo (webdriverio/webdriverio) v8 commits to keep the standalone v8 line at parity:

- webdriverio/webdriverio#15231 — Test Management: add `testManagementOptions.testPlanId` support (env `BROWSERSTACK_TEST_PLAN_ID` / `--browserstack.testManagementOptions.testPlanId` CLI arg / config), forward `test_management.test_plan_id` in the build-start request, strip CLI-only caps (`NOT_ALLOWED_KEYS_IN_CAPS`, incl. `testManagementOptions`) before hitting the hub, and surface build-start errors.
- webdriverio/webdriverio#15217 — gRPC: raise the send/receive message size limit to 20 MB to accommodate large extension payloads.
- webdriverio/webdriverio#15146 — Exit handling: terminate the CLI process with `SIGINT` instead of `SIGKILL` on Unix.
- webdriverio/webdriverio#15200 — Logging: redact credentials (username/accesskey/user/key) from CLI log output before writing to file and console.
