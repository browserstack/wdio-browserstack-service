---
"@wdio/browserstack-service": patch
---

Refresh the framework session id on `reloadSession` so Test Observability keeps linking to the correct session after a reload (#54), and declare `browser.setCustomTags` on the `WebdriverIO.Browser` type so it type-checks in consumer projects (SDK-6882, #53).
