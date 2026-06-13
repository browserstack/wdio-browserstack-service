# Migration plan — taking over `@wdio/browserstack-service`

This repo becomes the BrowserStack-owned home of the WebdriverIO service, published on BrowserStack's
own cadence, with **no change for end users** (`npm i @wdio/browserstack-service`, `services: ['browserstack']`
keep working byte-for-byte).

## Why a monorepo
This repository already publishes the gRPC/protobuf core **`@browserstack/wdio-browserstack-service`**,
which the service depends on. Rather than disturb that package, we keep it here and add the service
beside it as an npm workspace:

```
packages/core                  -> @browserstack/wdio-browserstack-service   (unchanged: buf + tsc, released by the SDK team)
packages/browserstack-service  -> @wdio/browserstack-service                (the WebdriverIO service)
```

- The service depends on the core via the normal npm range `^2.0.2`; npm links the local `packages/core`
  during development, and the **published** service still depends on the npm-published core.
- Changesets **ignores** the core (see `.changeset/config.json`), so this pipeline never versions or
  publishes it — the SDK team keeps releasing it exactly as before.

## Release model
- Versioned/published with **Changesets**, independent of WebdriverIO core's release schedule.
- `main` → `latest` dist-tag (v9 line); `v8` branch → `v8` dist-tag (via that branch's `publishConfig.tag`).
- Publishing uses **npm OIDC trusted publishing** — no long-lived token, provenance-signed, revocable.
  - One-time setup by an `@wdio` npm org admin: package `@wdio/browserstack-service` → Settings →
    Trusted Publisher → GitHub Actions → Org `browserstack`, Repo `wdio-browserstack-service`,
    Workflow `release.yml`, Environment empty.
  - Requires a public repo, npm ≥ 11.5.1, Node ≥ 22.14.

## Release-readiness fixes applied during the move
- Strict `files` allowlist on the service (`build`, `browserstack-service.d.ts`, `README.md`, `LICENSE`)
  → tarball is 80 files / ~590 kB (previously leaked internal docs, a log, a stray tarball, and
  `*.d.ts.map`).
- `declarationMap: false` in `tsconfig.prod.json` (no `.d.ts.map` in the package).
- Single, consistent toolchain: **npm workspaces** + `npm ci` everywhere (the earlier draft mixed pnpm
  with an npm lockfile and pinned Node 20, which would have failed CI/Release).
- `repository`/`homepage`/`bugs` point at `browserstack/wdio-browserstack-service` (+ `repository.directory`).

## Verification before any public PR (how customers actually use it)
1. `npm ci && npm run build && npm test` green (core builds via buf, service via esbuild + tsc).
2. `npm pack -w @wdio/browserstack-service` ships only `build/ + README + LICENSE + ambient d.ts`.
3. **Functional test:** in a fresh project, install the packed tarball + `webdriverio`, set
   `services: ['browserstack']`, and run a real BrowserStack session — assert the shorthand resolves,
   `webdriverio` dedupes to one copy, `./cleanup` works, and the session appears on the dashboard.
   Repeat for the v8 line.

## Cutover sequence (no publishing gap)
1. Land this monorepo conversion (PR-1) with SDK-team review.
2. `@wdio` npm admin configures OIDC trusted publishing for `@wdio/browserstack-service`.
3. First release from this repo at **≥ 9.29.0** (`latest`) and the next 8.x (`v8`) — must clear npm's
   current `9.28.0` / `8.48.0`.
4. Install the freshly published package from npm and re-run the functional test.
5. **Then** land the WebdriverIO monorepo PRs that remove the in-repo service and update docs links
   (main + v8), adding a redirect for `/docs/browserstack-service`.
6. Rollback if needed: re-point dist-tags; the WebdriverIO monorepo can keep publishing until step 5 merges.

## Companion docs
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how the service works and talks to BrowserStack.
- [`AUTO-UPDATE-AND-NPM-MECHANICS.md`](./AUTO-UPDATE-AND-NPM-MECHANICS.md) — why we publish to npm
  (vs hosted-core / auto-update approaches) and the npm distribution mechanics.
