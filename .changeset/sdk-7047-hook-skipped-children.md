---
"@wdio/browserstack-service": patch
---

Fix (SDK-7047): correct two CLI / TestHub-v2 (gRPC) flow regressions in Mocha hook handling.

1. **Skipped children of a failed hook** — the child tests of a failed `before all` / `before each` / `after each` hook were dropped from every Observability bucket. Their skipped-event synthesis (`sendSuiteSkipped` → `TestRunSkipped`) only ran on the legacy HTTP-listener path (inert in the CLI/v2 pipeline). `afterHook` now mirrors that synthesis over the gRPC `TestFramework` tracker, restoring them to the Skipped bucket at parity with the legacy flow.

2. **Failed-hook result mislabelled** — a failing hook's `HookRunFinished` was emitted with `result: "passed"` (so the build read green despite a hook failure). The CLI hook tracker derived the result from `testResult.status`, a field WebdriverIO's mocha hook wrapper never populates. It now derives from `passed`/`skipped` (mirroring `loadTestResult`), so a failed hook is correctly reported as `failed`.

Both regressions were introduced in 9.21.0 (the CLI/v2 flow) and affect 9.21.0–9.30.x; the legacy flow (≤9.20.1) was unaffected.
