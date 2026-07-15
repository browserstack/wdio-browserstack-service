---
"@wdio/browserstack-service": patch
---

Declare `webdriverio` as a dependency instead of a peerDependency, matching the v8 package published from the WebdriverIO monorepo (`@wdio/browserstack-service@8.48.3` keeps `webdriverio` in `dependencies` at `8.46.0`, peering only `@wdio/cli`). The extraction had moved it into `peerDependencies` (`^8.0.0`), which forces the consumer's `webdriverio` and can `npm ERESOLVE` against a dep peering a non-overlapping `webdriverio` range. Restores install parity with the upstream v8 package; no user-facing API change.
