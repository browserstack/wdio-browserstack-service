---
"@wdio/browserstack-service": patch
---

Fix (SDK-7047): emit the skipped child tests of a failed `before all` / `before each` / `after each` hook in the CLI / TestHub-v2 (gRPC) flow. These children were only ever synthesised on the legacy HTTP-listener path (`insights-handler.afterHook` → `sendSuiteSkipped`), which is inert in the CLI/v2 pipeline — so with Observability on, a failing suite-setup hook made its child tests disappear from every dashboard bucket (not even "Skipped"). `afterHook` now mirrors that synthesis over the gRPC `TestFramework` tracker, restoring the children to the Skipped bucket at parity with the legacy flow.
