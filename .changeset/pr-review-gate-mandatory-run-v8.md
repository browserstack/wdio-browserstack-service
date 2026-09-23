---
"@wdio/browserstack-service": patch
---

ci(sdk-pr-review-gate): the `gate` required check now turns green as soon as the SDK PR Review Agent has run on the PR's latest commit (any verdict), not only when it passes — verdict is advisory. Rolls the mandatory-to-run gate change (SDK-7256) onto the v8 line; main already has it via #202.
