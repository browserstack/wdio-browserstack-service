---
"@wdio/browserstack-service": patch
---

fix(a11y): restore per-command auto-scanning for App Automate accessibility sessions

App Automate accessibility sessions were skipped by the per-command `overwriteCommand`
wrapping in `onBeforeExecute` (guarded to `!isAppAccessibility`), so app a11y scans only
fired via an explicit `performScan()` or the end-of-test lifecycle scan — per-command
auto-scanning that web sessions get was effectively disabled for app. Command wrapping now
applies to app sessions too, with each `overwriteCommand` call individually guarded so a
command the appium driver does not register is skipped (logged at debug) instead of aborting
`onBeforeExecute`. Commands appium does register (`click`, `setValue`, ...) now auto-scan on
App Automate, matching the web flow.
