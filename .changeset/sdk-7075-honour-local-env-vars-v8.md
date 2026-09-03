---
"@wdio/browserstack-service": patch
---

- Fixed `BROWSERSTACK_LOCAL` and `BROWSERSTACK_LOCAL_IDENTIFIER` being ignored. Both env vars now configure BrowserStack Local — the tunnel is launched and the `local` / `localIdentifier` capabilities reach the session — and take precedence over `browserstackLocal` / `opts.localIdentifier` in `wdio.conf.js`, matching the other BrowserStack SDKs. Only a literal `BROWSERSTACK_LOCAL=false` disables Local; any other set value enables it, so `BROWSERSTACK_LOCAL=1` behaves the same here as on every other SDK. An identifier on its own still does not enable Local.
