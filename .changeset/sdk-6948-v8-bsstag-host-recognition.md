---
"@wdio/browserstack-service": patch
---

fix(util): recognize `*.bsstag.com` hosts as BrowserStack on internal staging envs (SDK-6948)

`getCloudProvider` and `isBrowserstackInfra` only matched `browserstack.com`, so a session pointed at an internal staging env (`*.bsstag.com`) was classified as non-BrowserStack: session marking and Automate <-> TRA session linking did not work there. `*.bsstag.com` hosts are now treated as BrowserStack when `BROWSERSTACK_STAGING_ENV` is a bare env name (e.g. `k8s`, trimmed; blank means unset) or `BROWSERSTACK_ENV` is `staging`/`stag`/`preprod`/`pre-prod`. Hosts are matched case-insensitively. Production behaviour is unchanged. With the CLI flow (the default), session marking and Automate <-> TRA session linking now work on those envs, because the binary supplies the staging session REST host. The classic (non-CLI) flow on a named staging env is not supported: it has no staging session REST host, so the session name/status update is skipped at debug instead of failing the hook. `_printSessionURL` and `_update` log a failed session lookup or update (HTTP error reply) at debug instead of throwing. Ports main/v9 #275 to the v8 line.
