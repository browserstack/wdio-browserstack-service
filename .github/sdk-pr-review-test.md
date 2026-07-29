# SDK PR Review Gate — test PR

Throwaway file used to open a test PR against the `v8` line so the
SDK PR Review Gate and the SDK PR Review Agent can be exercised end-to-end.

- No source, build, or runtime code is touched by this PR.
- Safe to close without merging; delete the branch afterwards.

Created: 2026-07-28
Target branch: `v8`

## Trigger log

- 2026-07-29 — dummy commit to fire a `synchronize` event on the PR.
