---
"@wdio/browserstack-service": patch
---

fix(cli): fall back to `BROWSERSTACK_BINARY_URL` when `update_cli` fails (SDK-6948)

`update_cli` runs during bootstrap — before the binary is spawned and before GRR localizes the API hosts — so it always targets production `api.browserstack.com`. On an internal staging run (`BROWSERSTACK_STAGING_ENV`) the staging credentials are rejected there (`401`), which left the CLI binary path empty and crashed the launcher with `spawn('') … ERR_INVALID_ARG_VALUE: 'file' cannot be empty`. When `update_cli` fails and `BROWSERSTACK_BINARY_URL` is set, download the binary from that URL instead so the run can proceed. Opt-in only — with the variable unset the original error propagates exactly as before.
