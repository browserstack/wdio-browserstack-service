---
"@wdio/browserstack-service": patch
---

Port SDK-6277 (upstream webdriverio/webdriverio#15330): in the CLI/binary (v8) flow, forward screenshot-on-failure to the binary over gRPC as a `TEST_SCREENSHOT` log (the binary uploads it via its own authorized testhub session) instead of the direct-HTTP `onScreenshot` path, which 401s under the worker's binary-issued JWT. Also registers the command/result listeners in CLI mode so the user's `saveScreenshot()`/`takeScreenshot()` result is captured, and honors the incoming log `kind` in the mocha CLI framework so screenshots route correctly. Keeps the standalone v8 line at parity with the monorepo.
