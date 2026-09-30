---
"@wdio/browserstack-service": patch
---

- Fixed custom test metadata set via `BrowserStackSDK.setTestMetadata()` being dropped when the metadata is set before the test-run UUID is assigned. A per-UUID lookup now falls back to the current-run metadata again, restoring the behaviour that shipped before 8.51.0.
