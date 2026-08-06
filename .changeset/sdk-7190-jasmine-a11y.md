---
"@wdio/browserstack-service": patch
---

fix: run Web Accessibility Automation scans for the jasmine framework (SDK-7190)

The accessibility handler's beforeTest/afterTest hooks were hard-gated to mocha, so jasmine sessions with `accessibility: true` were provisioned on the A11y side (build registered, extension injected) but never orchestrated a scan or saved results — silently producing no report. WDIO's jasmine adapter emits the same beforeTest/afterTest service hooks as mocha, so the gate now admits jasmine, and the scan include/exclude filter reads the spec name from jasmine's `description` field.
