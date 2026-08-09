# wdio-browserstack-service

Home of [`@wdio/browserstack-service`](https://www.npmjs.com/package/@wdio/browserstack-service) — the BrowserStack WebdriverIO integration, maintained by BrowserStack.

| Package | npm | What it is |
|---|---|---|
| [`packages/browserstack-service`](./packages/browserstack-service) | [`@wdio/browserstack-service`](https://www.npmjs.com/package/@wdio/browserstack-service) | The WebdriverIO service users add via `services: ['browserstack']`. Its gRPC/protobuf client is generated from the bundled `.proto` files at build time. |

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

This is an npm workspace with a single published package.

```sh
npm ci              # install
npm run build       # generate the gRPC client from proto, then compile
npm test            # run the service test suite
```

- `npm run generate` (inside the package) runs `buf generate` to emit the gRPC/protobuf client into `src/grpc/generated` from the `.proto` files under `src/proto`. `npm run build` runs this automatically before compiling, so the generated code is never committed.
- The service is bundled with esbuild (deps kept external) and ships TypeScript declarations from `tsc`.

## Releases

`@wdio/browserstack-service` is versioned and published with [Changesets](https://github.com/changesets/changesets)
on BrowserStack's own cadence (independent of WebdriverIO core's release schedule):

- `main` → `latest` dist-tag (v9 line)
- `v8` branch → `v8` dist-tag (v8 line)

Publishing uses **npm OIDC trusted publishing** (no long-lived token; provenance-signed). The gRPC/protobuf
client is generated inline at build time from the `.proto` files in this repo — there is no separately
published core package.
