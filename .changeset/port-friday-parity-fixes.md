---
"@wdio/browserstack-service": patch
---

Port the 2026-07-10 monorepo accessibility/CLI fixes to keep the standalone at parity (webdriverio/webdriverio#15380, #15383, #15382, #15381, #15376): skip the accessibility scan for BiDi `window`/`context` commands, route WDIO CLI-flow App Automate sessions to app-accessibility, finalize orphaned test runs on an interrupted exit, coerce stringified boolean accessibility options, and report mocha hooks in the CLI/testHub flow. No user-facing API change.
