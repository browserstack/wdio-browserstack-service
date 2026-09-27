---
"@wdio/browserstack-service": patch
---

- Fixed a configured `buildIdentifier` being silently dropped whenever `BROWSERSTACK_BUILD_NAME` was exported. The identifier is now only skipped when there is genuinely no build name in the capabilities, so builds keep the suffix the user asked for.
- Added `BROWSERSTACK_BUILD_IDENTIFIER` and `BROWSERSTACK_BUILD_RUN_IDENTIFIER` support. Either env var now sets the build identifier, taking precedence over the value in the service options or capabilities, matching the other BrowserStack SDKs.
- `buildIdentifier` now resolves any `${ENV_VAR}` placeholder against the environment, not just `${BUILD_NUMBER}` and `${DATE_TIME}`. An unset variable is left as-is rather than blanked.
