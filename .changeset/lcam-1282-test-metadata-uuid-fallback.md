---
"@wdio/browserstack-service": patch
---

- Fixed custom test metadata set via `BrowserStackSDK.setTestMetadata()` being dropped when the metadata is set before the test-run UUID is assigned. A per-UUID lookup now serves the current-run metadata when no per-UUID metadata has been recorded, while still refusing to leak one test run's metadata into another once per-UUID tracking is active.
