---
"@wdio/browserstack-service": patch
---

fix(cli): send `update_cli` to the staging env's REST API host when `BROWSERSTACK_STAGING_ENV` is set (SDK-6948)

`update_cli` runs during bootstrap, before GRR localizes the API hosts, so on an internal staging run it went to production `api.browserstack.com` and was rejected (401) with staging creds. When `BROWSERSTACK_STAGING_ENV` holds a valid env name (one DNS label, trimmed and lowercased), the request now goes to that env's API host: `https://api-preprod.bsstag.com` for `preprod`, otherwise `https://api<env>.bsstag.com`. An unset or invalid value leaves the request unchanged. Nothing else changes: there is no client-side fallback, and `BROWSERSTACK_BINARY_URL` is still applied only after a successful `update_cli` reply.
