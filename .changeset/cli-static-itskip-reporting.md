---
"@wdio/browserstack-service": patch
---

- Fixed a statically-skipped test (`it.skip`) being left orphaned as "in progress" on the Test Observability dashboard in the CLI flow. Such tests are reported from the un-awaited `onTestSkip` reporter hook, so their `TestRunFinished` event could still be pending when the worker tore down; the `after()` hook now drains these skip reports before the session closes so the test is correctly reported as skipped.
