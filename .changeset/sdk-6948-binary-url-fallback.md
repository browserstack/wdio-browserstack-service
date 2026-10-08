---
"@wdio/browserstack-service": patch
---

fix(cli): fall back to `BROWSERSTACK_BINARY_URL` when `update_cli` fails (SDK-6948)

`update_cli` runs during bootstrap against production `api.browserstack.com`, so on an internal staging run (`BROWSERSTACK_STAGING_ENV`) it answers `401`. The SDK then found no CLI binary and fell back to the non-CLI flow, or silently reused a stale cached binary. When `update_cli` fails (non-2xx, network error, or a reply with neither `url` nor `updated_cli_version`) and `BROWSERSTACK_BINARY_URL` is set, the binary is now downloaded from that URL. `CLIUtils.requestToUpdateCLI` now rejects on a non-2xx reply (with `response.statusCode`) instead of resolving the error body. With `BROWSERSTACK_BINARY_URL` unset, behaviour is unchanged: a non-2xx reply keeps the existing binary, and network errors propagate.
