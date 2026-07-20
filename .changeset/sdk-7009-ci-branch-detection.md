---
"@wdio/browserstack-service": patch
---

Detect the git branch in detached-HEAD CI checkouts. CI systems typically check out a commit SHA directly (`git checkout <sha>`), leaving the repo in a detached-HEAD state where `git-repo-info` cannot resolve a branch — so builds reported no branch and dropped out of branch-based dashboards and filters. `getGitMetaData` now falls back to the CI provider's branch env var (with an explicit `BROWSERSTACK_GIT_BRANCH` override) and a `git for-each-ref` backstop. (SDK-7009)
