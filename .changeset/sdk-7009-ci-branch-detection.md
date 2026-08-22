---
"@wdio/browserstack-service": patch
---

Detect the git branch in detached-HEAD CI checkouts. CI systems typically check out a commit SHA directly (`git checkout <sha>`), leaving the repo in a detached-HEAD state where `git-repo-info` cannot resolve a branch — so builds reported no branch and dropped out of branch-based dashboards and filters. `getGitMetaData` now resolves the branch in this precedence: an explicit `BROWSERSTACK_GIT_BRANCH` override (which wins even over a git-repo-info-resolved branch, so it can correct a mis-detected one) → `git-repo-info` → the CI provider's branch env var → a `git for-each-ref --points-at HEAD` backstop. Provider-specific env vars are trusted directly; generic names (`BRANCH`, `GIT_BRANCH`, …) are only used when a CI environment is detected. (SDK-7009)
