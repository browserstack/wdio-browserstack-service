---
"@wdio/browserstack-service": minor
---

- Added `browser.uploadAttachment(filePath)` (also available as `browser.uploadMedia`) so WebdriverIO tests can attach files to a test, hook, or build in Test Reporting — the same capability the Java, Python and Node SDKs already offer. Pass `{ buildAttachment: true }` to attach to the build instead of the current test.
- Made BrowserStack session bootstrap tolerant of an incomplete configuration response. Previously an empty or partial response aborted the whole bootstrap, which silently disabled every BrowserStack feature for that run — including custom tags and Test Reporting — and could leave the build with no test results.
