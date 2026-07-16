---
"@wdio/browserstack-service": patch
---

Declare `browser.setCustomTags(key, value)` on the global `WebdriverIO.Browser` interface so TypeScript consumers can call it without a `TS2339` compile error. The command already worked at runtime; the declaration previously lived only in `src/@types/bstack-service-types.d.ts`, which is never emitted into the shipped `build/index.d.ts`. No runtime change.
