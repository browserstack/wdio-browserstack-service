---
"@wdio/browserstack-service": patch
---

Declare `webdriverio` as a dependency instead of a peerDependency, matching the package published from the WebdriverIO monorepo. The extraction had moved `webdriverio` into `peerDependencies` (`^9.0.0`); npm then forced the consumer's `webdriverio` to `^9`, which conflicts with any project that also depends on a package peering `webdriverio@"^7 || ^8"` (e.g. `wdio-chromedriver-service@^8`) and surfaced as an `npm ERESOLVE` on install — a failure the monorepo-published package never had. Restores install parity with the upstream package; no user-facing API change.
