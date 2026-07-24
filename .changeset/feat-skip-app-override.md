---
"@wdio/browserstack-service": minor
---

Add a `skipAppOverride` service option for App Automate (Appium) runs. With `skipAppOverride: true` the service classifies the session as App Automate even when no `app` option is set, does not upload an app, and does not inject an `appium:app` capability — the user supplies the app reference themselves (e.g. a pre-uploaded `bs://` hash as a driver capability or via `BROWSERSTACK_APP_ID`). Setting it together with an `app` option logs a conflict warning and ignores the `app` option; `skipAppOverride: false` with no `app` fails fast with a configuration error before any session starts. Unset keeps existing behaviour unchanged.