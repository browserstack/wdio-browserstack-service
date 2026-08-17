---
"@wdio/browserstack-service": patch
---

- Fixed `BROWSERSTACK_LOCAL` and `BROWSERSTACK_LOCAL_IDENTIFIER` being ignored. Both env vars now configure BrowserStack Local — the tunnel is launched and the `local` / `localIdentifier` capabilities reach the session — and take precedence over `browserstackLocal` / `opts.localIdentifier` in `wdio.conf.js`, matching the other BrowserStack SDKs. An identifier on its own still does not enable Local.
