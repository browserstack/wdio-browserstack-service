# Changesets — v8 maintenance line

This is the **v8 line** of `@wdio/browserstack-service` (for WebdriverIO v8 / Node 16+ users).
It versions and publishes independently of v9, on BrowserStack's own timeline.

```sh
npx changeset            # record a change (patch/minor) on the v8 line
```

Releases from this branch publish to the **`v8` npm dist-tag** (set via
`publishConfig.tag` in `package.json`), so they NEVER move `latest` (which points at v9).
`baseBranch` here is `v8`. See `EXTRACTION-V8.md` for the dist-tag strategy.
