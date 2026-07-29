---
"@wdio/browserstack-service": patch
---

- Fixed SDK logs not being uploaded when a test run is interrupted (Ctrl-C or CI job cancellation); interrupted runs are now reported with their termination reason on the build record.
