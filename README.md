# wdio-browserstack-service

Monorepo for the BrowserStack WebdriverIO integration, maintained by BrowserStack.

| Package | npm | What it is |
|---|---|---|
| [`packages/browserstack-service`](./packages/browserstack-service) | [`@wdio/browserstack-service`](https://www.npmjs.com/package/@wdio/browserstack-service) | The WebdriverIO service users add via `services: ['browserstack']`. |
| [`packages/core`](./packages/core) | [`@browserstack/wdio-browserstack-service`](https://www.npmjs.com/package/@browserstack/wdio-browserstack-service) | gRPC/protobuf core SDK consumed by the service. |

## Usage (for end users)

Nothing changes — install the service and add it to your WebdriverIO config:

```sh
npm i -D @wdio/browserstack-service
```

```js
// wdio.conf.js
export const config = {
  services: ['browserstack'],
  // ...
}
```

See the [service README](./packages/browserstack-service/README.md) for full configuration.

## Development

This is an npm workspace.

```sh
npm ci              # install all packages
npm run build       # build core then service
npm test            # run the service test suite
```

- `npm run build:core` / `npm run build:service` build a single package.
- The service is bundled with esbuild (deps kept external) and ships TypeScript declarations from `tsc`.

## Releases

`@wdio/browserstack-service` is versioned and published with [Changesets](https://github.com/changesets/changesets)
on BrowserStack's own cadence (independent of WebdriverIO core's release schedule):

- `main` → `latest` dist-tag (v9 line)
- `v8` branch → `v8` dist-tag (v8 line)

Publishing uses **npm OIDC trusted publishing** (no long-lived token; provenance-signed). The gRPC core
`@browserstack/wdio-browserstack-service` is released separately by the SDK team and is excluded from the
Changesets pipeline (see [`.changeset/config.json`](./.changeset/config.json)).
