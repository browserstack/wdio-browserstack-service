# Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) to version and publish
**`@wdio/browserstack-service`** on BrowserStack's own cadence (independent of WebdriverIO's
release schedule).

- Add a changeset for any user-facing change: `npm run changeset` (pick patch/minor/major).
- On merge to `main` (the v9 line) or `v8` (the v8 line), the Release workflow opens a
  "Version Packages" PR; merging that PR publishes to npm via OIDC trusted publishing.
- The gRPC/protobuf core **`@browserstack/wdio-browserstack-service`** is in `ignore` (see
  `config.json`) — it is versioned and published separately by the SDK team and is never
  touched by this pipeline.
