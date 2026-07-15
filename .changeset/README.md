# Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) to version and publish
**`@wdio/browserstack-service`** on BrowserStack's own cadence (independent of WebdriverIO's
release schedule).

- Add a changeset for any user-facing change: `npm run changeset` (pick patch/minor/major).
- On merge to `main` (the v9 line) or `v8` (the v8 line), the Release workflow opens a
  "Version Packages" PR; merging that PR publishes to npm via OIDC trusted publishing.
- The gRPC/protobuf client is generated inline from the bundled `.proto` files at build time
  (`buf generate`) — it is no longer a separate workspace package, so `config.json` `ignore` is
  empty and there is nothing extra for this pipeline to skip.
