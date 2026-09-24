---
"@wdio/browserstack-service": patch
---

fix(util): recognize `*.bsstag.com` hosts as BrowserStack (internal staging, SDK-6948)

`getCloudProvider` and `isBrowserstackInfra` only matched `browserstack.com`, so a session pointed at an internal staging env (`*.bsstag.com`) was classified as non-BrowserStack — the service then skipped its instrumentation and GRR host rewriting, and the WebDriver hub stayed on production. Recognize `bsstag` / `.bsstag.com` in both guards. Ports the main/v9 fix (#56/#65) to the v8 line.
