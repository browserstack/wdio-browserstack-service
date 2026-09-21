---
"@wdio/browserstack-service": patch
---

fix(a11y): skip unregistered commands instead of aborting accessibility command wrapping

`AccessibilityModule.onBeforeExecute` wrapped every entry of the server-sent
`commandsToWrap` list in a single unguarded loop. The list can name a command the active
driver never registered — appium sessions omit web-only commands, and the list also carries
Selenium-shaped entries (`startA11yScanning`, `stopA11yScanning`, `performScan` with class
`HttpCommandExecutor`) intended for other SDKs. WebdriverIO's `overwriteCommand` throws on an
unknown name, so the first such entry aborted the whole loop and left every command after it
unwrapped, surfacing as `Error in onBeforeExecute: overwriteCommand: no command to be
overwritten: startA11yScanning`. Each `overwriteCommand` call is now individually guarded, so
an unknown name is skipped (logged at debug) and the rest of the list still auto-scans. Ports
the guard already shipped on the v9 line.
