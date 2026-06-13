# Code changes for the extraction — what, why, and how they communicate

This explains **every change** made to turn the in-monorepo `@wdio/browserstack-service`
into a standalone, independently-releasable package — *why* each is needed, its *purpose*,
and how it changes the way this package **communicates** with:

- **the external repo** = upstream WebdriverIO core (`webdriverio`, `@wdio/types`, `@wdio/reporter`, `@wdio/logger`, `@wdio/cli`), and
- **BrowserStack's own service code** = the `@browserstack/*` SDKs (`@browserstack/wdio-browserstack-service` gRPC client, `@browserstack/ai-sdk-node`).

> **The one principle:** we changed only the **plumbing** (how the package is *built, tested,
> released, and wired to its dependencies*). The service's **runtime behaviour is unchanged** —
> the only source edit is a one-line lifecycle fix (`unref`, §6). Everything users rely on
> (package name, `services: ['browserstack']`, the `exports` map, options) is untouched.

---

## The 3 communication boundaries (and which changes touch them)

```
            ┌─────────────────────────── your Node process ───────────────────────────┐
 consumer → │  @wdio/cli / @wdio/runner   ⇄(hooks)⇄   @wdio/browserstack-service        │
 (sample/   │                                          │        │                       │
  user)     │   webdriverio, @wdio/logger,   ⇄(peer)⇄  │        │ ⇄(deps)⇄  @browserstack│ → BrowserStack
            │   @wdio/reporter, @wdio/types  (shared)   │        │           /* SDKs */    │    cloud (gRPC/REST)
            └───────────────────────────────────────────────────┘
                          ▲ boundary 1: upstream core      ▲ boundary 2: BrowserStack SDK
                          (CHANGED: deps → peerDeps)        (UNCHANGED: regular deps)
```

| Boundary | What it is | Did the extraction change it? |
|---|---|---|
| **1. Upstream WebdriverIO core** | `webdriverio`, `@wdio/types/reporter/logger`, `@wdio/cli` | **Yes** — moved to `peerDependencies` (§1). This is the headline change. |
| **2. BrowserStack SDKs** | `@browserstack/wdio-browserstack-service` (gRPC), `@browserstack/ai-sdk-node` | **No** — still regular `dependencies`; runtime gRPC/SDK calls identical. |
| **3. Consumers** | user projects loading `services: ['browserstack']` | **No** — same name, same `exports`, same service interface. |

---

## Summary of changes

| # | Change | Why / purpose | Communication impact |
|---|---|---|---|
| 1 | `package.json`: core deps `workspace:*` → **`peerDependencies` (`^9`)** + devDeps | Stop bundling our own copy of WDIO core; use the host's | **Boundary 1** — now shares the consumer's *instances* of webdriverio/logger/reporter |
| 2 | `package.json`: add `scripts` (build/test/version/release) | The monorepo built/released centrally; standalone needs its own | Replaces the monorepo's build/release "communication" |
| 3 | `tsconfig.json`: self-contained (drop `../../tsconfig`, `../../@types`) | Remove build-time coupling to the monorepo root | Severs compile-time dependency on the external repo |
| 4 | `tsconfig.prod.json` (new) | Emit only `.d.ts` for the published build | Defines the public **type** contract shipped to consumers |
| 5 | `scripts/build.mjs` (new) | Replace the shared `@wdio/compiler` | Produces the **same `build/` + `exports`** so loader/consumers resolve identically |
| 6 | `src/request-handler.ts`: `.unref()` | Don't let the poll timer keep the process/worker alive | The **only** runtime change; behaviour otherwise identical |
| 7 | `vitest.config.ts` + `__mocks__/` (new) | Replace the monorepo root test config + root mocks | Test-time only; reporter mock now talks to **published** `@wdio/reporter` |
| 8 | `.changeset/` + `.github/workflows/` (new) | Replace Lerna lockstep with independent OIDC publishing | Replaces release "communication" with the TSC train |
| 9 | `.npmignore`, `repository`/`homepage`/`bugs` | Keep the tarball lean; point metadata at the new repo | Packaging metadata; provenance later needs an exact repo match |

---

## 1. `dependencies` → `peerDependencies` (the important one)

**Before (in the monorepo):**
```jsonc
"dependencies": {
  "@wdio/logger": "workspace:*", "@wdio/reporter": "workspace:*",
  "@wdio/types": "workspace:*", "webdriverio": "workspace:*", ...
}
```
At publish, `workspace:*` was frozen to an **exact** version (e.g. `webdriverio: 9.27.2`), so the
package effectively **owned its own copy** of WDIO core.

**After (standalone):**
```jsonc
"peerDependencies": {
  "webdriverio": "^9.0.0", "@wdio/types": "^9.0.0",
  "@wdio/reporter": "^9.0.0", "@wdio/logger": "^9.0.0",
  "@wdio/cli": "^5.0.0 || ... || ^9.0.0"
},
"devDependencies": { "webdriverio": "^9.0.0", "@wdio/types": "^9.0.0", ... }  // for build/test only
```

**Why it's needed.** Inside the monorepo, `workspace:*` symlinks to the sibling packages, so
there's always exactly one copy. Once published from outside, an *exact regular dependency* on
`webdriverio` would install a **second copy** into the user's tree (they already have `webdriverio`).

**Purpose.** Make the host project *provide* WDIO core; this package binds to **those** instances.

**Communication impact (boundary 1) — this is the crux.** The service imports *values* from core:
`SevereServiceError` (from `webdriverio`), the logger (`@wdio/logger`), `WDIOReporter`
(`@wdio/reporter`). For those to work, the service must use the **same module instances** the
runner uses:
- `instanceof SevereServiceError` checks only pass if both sides import the *same* class.
- the logger must be the *same* singleton the framework configured.
- the reporter event bus must be shared.

`peerDependencies` guarantee a **single shared copy** (verified: `npm ls webdriverio` → one). A
regular-dep duplicate would silently break these. The `devDependencies` entries exist only so the
package can **build and unit-test** itself in isolation; they're not shipped.

> `@wdio/cli` keeps its historical wide peer range (`^5 || … || ^9`) because the service never
> imports it — it's only the host runner; the four core packages use `^9` because that's what this
> line is actually built against.

---

## 2. `scripts` (build / test / version / release)

**Why.** The monorepo had **no per-package scripts** — a central pipeline built and released every
package. Standalone, the package must do this itself.

**Purpose.** `build` (esbuild + tsc), `build:watch` (dev loop), `test` (Vitest), `version`/`release`
(Changesets).

**Communication impact.** Replaces the *release-time* communication with the monorepo's Lerna train
(see §8). No runtime impact.

---

## 3. `tsconfig.json` made self-contained

**Why.** It used `extends: "../../tsconfig"` and `include: ["../../@types"]` — i.e. it read config
from the **monorepo root**, which doesn't exist outside it.

**Purpose.** Inline the compiler options the root used; drop the `../../@types` include (the package
has its own `src/@types`).

**Communication impact.** Severs the **compile-time** coupling to the external repo. No effect on the
published JS or on runtime.

## 4. `tsconfig.prod.json` (new)

**Why/purpose.** A declaration-only profile (`emitDeclarationOnly`, excludes tests) that `build`
uses to emit `build/*.d.ts`.

**Communication impact.** Defines the **TypeScript type contract** shipped to consumers
(`types: ./build/index.d.ts`) — must stay equivalent to the monorepo's emitted types so downstream
type-checking is unchanged.

## 5. `scripts/build.mjs` (new) — replaces `@wdio/compiler`

**Why.** The monorepo built every package with a shared esbuild-based `@wdio/compiler` in
`infra/compiler`; that tool isn't available standalone.

**Purpose.** Reproduce it for this one package: one ESM bundle per `exports` entry
(`.` → `build/index.js`, `./cleanup` → `build/cleanup.js`), every dependency/peer marked **external**
(only our `src` is bundled), `tsc` emits the `.d.ts`.

**Communication impact.** It deliberately produces the **same `build/` layout and the same `exports`
entrypoints** as before. That's what keeps **boundary 3** intact — WebdriverIO's plugin loader
(`initializePlugin`) and any consumer resolve `@wdio/browserstack-service` and `.../cleanup`
exactly as they did when the monorepo built it. Marking deps external is also what *implements*
boundary 1/2: the bundle contains no copy of `webdriverio` or the `@browserstack` SDKs — it
`import`s them at runtime from the consumer's `node_modules`.

---

## 6. `src/request-handler.ts` — `.unref()` (the only runtime change)

```ts
this.pollEventBatchInterval = setInterval(this.sendBatch.bind(this), DATA_BATCH_INTERVAL)
this.pollEventBatchInterval?.unref?.()   // ← added
```

**Why.** The Test-Ops batch poller is a `setInterval` that, un-`unref`'d, keeps the Node event loop
(and a Vitest worker) alive forever — which made the full standalone test suite hang.

**Purpose.** Let the timer **not** hold the process open on its own; it still fires on schedule while
the process is otherwise running, so **batching behaviour is unchanged** in a real run.

**Communication impact.** None to any boundary — it's a process-lifecycle fix, not a protocol/data
change. (It's the single line that touches runtime; everything else is build/test/release plumbing.)

---

## 7. `vitest.config.ts` + `__mocks__/` (new)

**Why.** Tests were driven by the monorepo **root** `vitest.config.ts` and resolved manual mocks from
the **root `__mocks__/`** — neither exists standalone.

**Purpose.** A local Vitest config (same env/pool/setup) and a copy of the mocks the suite needs
(`@wdio/logger`, `@wdio/reporter`, `browserstack-local`, `fs`, `chalk`, `fetch`).

**Communication impact (test-time only).** The `@wdio/reporter` mock was **adapted** to import the
stats classes + `getBrowserName` from the **published `@wdio/reporter`** instead of monorepo source
paths (`../../packages/wdio-reporter/src/...`) — i.e. the test now "communicates" with the published
package, matching how the real build resolves it. No effect on shipped code.

---

## 8. `.changeset/` + `.github/workflows/` (new)

**Why.** In the monorepo, releases were a **TSC-triggered Lerna lockstep** publish. Standalone, the
package versions and publishes itself.

**Purpose.** Changesets for independent versioning; `release.yml` publishes to npm via **OIDC trusted
publishing** (no long-lived token); `ci.yml` builds/tests on PRs.

**Communication impact.** Replaces the *release-time* communication with the WebdriverIO TSC train:
the package will publish under the **same `@wdio` scope** from this repo once the TSC delegates a
trusted publisher. Until then these workflows are inert templates (Actions only run at a repo root).

## 9. `.npmignore` + `repository`/`homepage`/`bugs`

**Why/purpose.** Keep the published tarball to `build/` + `README` + `LICENSE` + types (exclude
`src`, tests, mocks, scripts, configs, docs); point metadata at the new repo.

**Communication impact.** Packaging only. Note: for **provenance** at publish time, `repository.url`
must match the building repo **exactly** — so it must be set to the final home before the first
signed publish.

---

## What did NOT change (so users are unaffected)

- **`name`** (`@wdio/browserstack-service`), **`exports`** (`.` + `./cleanup`), **`type: module`**, **`engines`**, `publishConfig`.
- All **runtime feature code** (launcher, Local tunnel, Test Observability, Accessibility, AI, Percy) — byte-identical except the one `unref` line.
- The **`@browserstack/*` SDK dependencies** (boundary 2) — same versions, same gRPC/REST communication.
- The **service interface** WDIO calls (`onPrepare`, `beforeSession`, `beforeTest`, `after`, `onComplete`, …).

This is why the extraction is *plumbing*: it changes **where the package is built and released and
how it declares its dependencies**, not **what it does at runtime**.

> See also: [`ARCHITECTURE.md`](./ARCHITECTURE.md) (the full picture), [`EXTRACTION.md`](../EXTRACTION.md)
> (cutover checklist), [`DEV-TESTING.md`](./DEV-TESTING.md) (how to verify locally).
