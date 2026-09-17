---
"@wdio/browserstack-service": major
---

Remove the AI self-healing integration (the `selfHeal` option and its `@browserstack/ai-sdk-node` dependency). This integration is end-of-life and the upstream helpers it relied on have been removed, so self-heal is no longer supported by this service.
