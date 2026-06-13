# Architecture: extracting `@wdio/browserstack-service` from the WebdriverIO monorepo

> Deep-dive companion to [`EXTRACTION.md`](../EXTRACTION.md) (the cutover checklist) and
> [`TSC-PROPOSAL.md`](./TSC-PROPOSAL.md) (the governance ask).
> This document explains **how things work today**, **what changes**, **why we chose this
> approach over the alternatives**, and **how every form of communication works after the move**.

---

## 0. TL;DR

We are moving the **source code and release pipeline** of `@wdio/browserstack-service` out of the
`webdriverio/webdriverio` monorepo into a BrowserStack-owned repository, **while keeping the package
published under the exact same `@wdio/browserstack-service` name and `@wdio` npm scope**.

- **For users: nothing changes.** Same `npm i @wdio/browserstack-service`, same
  `services: ['browserstack']`, same docs.
- **For BrowserStack: independent releases.** No longer gated by WebdriverIO's lockstep,
  TSC-triggered release train.
- **The model is proven.** WebdriverIO already does this for `@wdio/visual-service` and
  `@wdio/electron-service`. We validated it end-to-end (standalone build + a real BrowserStack
  session that loaded the independently-built package via `services: ['browserstack']`).

```mermaid
flowchart LR
    subgraph TODAY["TODAY — inside the monorepo"]
        M["webdriverio/webdriverio<br/>(39 packages, Lerna lockstep)"]
        M --> P1["@wdio/browserstack-service<br/>released ONLY when the TSC<br/>publishes the whole train"]
    end
    subgraph TARGET["TARGET — own repo, same npm name"]
        R["browserstack/wdio-browserstack-service<br/>(Changesets, BrowserStack-controlled)"]
        R --> P2["@wdio/browserstack-service<br/>same name + scope,<br/>released on BrowserStack's cadence"]
    end
    TODAY -->|"extract, keep the name"| TARGET
    style TARGET fill:#e6ffe6
    style TODAY fill:#fff0f0
```

---

## 1. What the package actually is

`@wdio/browserstack-service` is the official WebdriverIO integration for BrowserStack. It is a
**WebdriverIO "service"** — a plugin that hooks into the test lifecycle. It bundles a large feature
set: Automate session management, the BrowserStack Local tunnel, Test Observability / TestHub,
Accessibility, AI self-healing, and Percy visual testing.

- npm: `@wdio/browserstack-service` — latest `9.27.2`, ~1M downloads/month, MIT, **ESM-only**, Node `>=18.20.0`.
- Two entrypoints: `.` (the service + launcher) and `./cleanup` (a standalone cleanup process).
- Today it lives at `packages/wdio-browserstack-service` in the monorepo. Its npm owners are
  WebdriverIO maintainers (not BrowserStack accounts) — BrowserStack contributes the logic and the
  `@browserstack/*` SDKs it depends on.

---

## 2. How things work TODAY (current architecture)

### 2.1 Where the code lives — the monorepo

```mermaid
flowchart TD
    subgraph MONO["webdriverio/webdriverio (pnpm workspace + Lerna)"]
        direction TB
        CORE["Core packages<br/>webdriverio · webdriver · @wdio/cli<br/>@wdio/utils · @wdio/types · @wdio/reporter · @wdio/logger"]
        SVC["Service packages<br/>@wdio/sauce-service · @wdio/browserstack-service · …"]
        COMPILER["infra/compiler (@wdio/compiler)<br/>shared esbuild build"]
        LERNA["lerna.json → version: 9.27.2 (FIXED mode)"]
    end
    CORE -. "workspace:* (symlinked)" .-> SVC
    COMPILER --> SVC
    COMPILER --> CORE
    LERNA --> CORE
    LERNA --> SVC
```

Key facts (all verified against the repo):
- **pnpm workspace + Lerna**, `packages/*`. Internal deps use the `workspace:*` protocol (symlinked
  locally; pinned to exact versions at publish time).
- **Lerna FIXED mode** — `lerna.json` has `"version": "9.27.2"` (not `"independent"`). Every package
  shares one version, bumped together.
- A shared **`@wdio/compiler`** (esbuild) builds every package; there is **no per-package build script**.

### 2.2 The build pipeline today

```mermaid
flowchart LR
    SRC["packages/wdio-browserstack-service/src/*.ts"] --> ESB["@wdio/compiler (esbuild)<br/>bundle each exports entry<br/>deps marked EXTERNAL"]
    ESB --> JS["build/index.js<br/>build/cleanup.js"]
    SRC --> TSC["tsc --emitDeclarationOnly"]
    TSC --> DTS["build/*.d.ts"]
    JS --> PKG["published tarball"]
    DTS --> PKG
```

The compiler bundles only the package's own `src` (every dependency stays external) and `tsc`
emits the `.d.ts` files. This is driven centrally from the monorepo root.

### 2.3 The release pipeline today — lockstep, TSC-gated

```mermaid
sequenceDiagram
    participant Dev as BrowserStack engineer
    participant PR as webdriverio/webdriverio PR
    participant TSC as TSC member
    participant GHA as "Manual NPM Publish" workflow
    participant NPM as npm registry

    Dev->>PR: open PR with a fix/feature
    PR->>TSC: review + merge (lands on main)
    Note over Dev,TSC: fix now sits on main, UNRELEASED…
    TSC->>GHA: manually trigger workflow_dispatch
    GHA->>GHA: authorize.yml — is actor in<br/>technical-steering-committee team?
    GHA->>NPM: pnpm lerna publish <type> (one shared version)
    NPM-->>NPM: bumps ALL changed @wdio/* together (e.g. 9.27.2 → 9.27.3)
```

- The publish workflow is **`workflow_dispatch` only** and runs an `authorize` job that checks
  **`technical-steering-committee`** GitHub-team membership. BrowserStack cannot trigger it.
- One `lerna publish` bumps the **single shared version** for all changed packages.
- So a BrowserStack-only fix waits for the next TSC-run train, and ships under whatever the global
  version becomes. **This is the core pain.**

### 2.4 How users consume it (and the resolution mechanism)

A user writes this and never references a package path:

```js
// wdio.conf.js
export const config = {
  services: [['browserstack', { /* options */ }]]
}
```

WebdriverIO turns the shorthand `'browserstack'` into a real package via `initializePlugin()` in
`@wdio/utils`. **This is the single most important mechanism for "nothing changes for users":**

```mermaid
flowchart TD
    A["services: browserstack (shorthand)"] --> B{"name starts with '@'<br/>or is absolute path?"}
    B -- yes --> Z["import that string directly"]
    B -- no --> C["try import: @wdio/browserstack-service"]
    C -- found --> OK["✅ loaded"]
    C -- not found --> D["try import: wdio-browserstack-service"]
    D -- found --> OK
    D -- not found --> ERR["❌ throw 'make sure you have it installed'"]
    style C fill:#e6ffe6
    style OK fill:#e6ffe6
```

- It **`import()`s whatever is installed** — there is **no runtime auto-install**.
- The scoped name `@wdio/browserstack-service` is tried **first**.
- ⇒ As long as we keep publishing under `@wdio/browserstack-service`, the shorthand keeps resolving
  with **zero config or install changes**. (npm scopes can't be moved to another scope — which is
  exactly why we keep `@wdio`.)

### 2.5 Runtime communication today (three boundaries)

At runtime the service talks across three boundaries. **None of these change after the move.**

```mermaid
flowchart LR
    subgraph USER["User's machine / CI (the Node process)"]
        CLI["@wdio/cli + @wdio/runner<br/>(the test runner)"]
        CORE["webdriverio / @wdio/logger / @wdio/reporter / @wdio/types<br/>(installed once)"]
        BS["@wdio/browserstack-service<br/>(launcher + worker service)"]
        LOCAL["browserstack-local tunnel"]
    end
    subgraph CLOUD["BrowserStack cloud"]
        HUB["hub.browserstack.com<br/>(WebDriver / Automate)"]
        API["api.browserstack.com<br/>session name, TestHub/Observability, funnel"]
        GRPC["TCG / binSession (gRPC)<br/>@browserstack/wdio-browserstack-service"]
        PERCY["Percy"]
    end

    CLI -- "calls lifecycle hooks<br/>(onPrepare, beforeSession, beforeTest, after, onComplete)" --> BS
    BS -- "imports values/types<br/>(SevereServiceError, logger, WDIOReporter)" --> CORE
    BS -- "REST (undici/global fetch)" --> API
    BS -- "gRPC" --> GRPC
    BS -- "Percy SDKs" --> PERCY
    BS -- "opens tunnel" --> LOCAL
    LOCAL --> HUB
    CORE -- "WebDriver commands" --> HUB
```

1. **Service ⇄ WebdriverIO core (in-process):** the runner (`@wdio/cli`/`@wdio/runner`) calls the
   service's lifecycle hooks. The service imports a few **values** from core — `SevereServiceError`
   from `webdriverio`, the default logger from `@wdio/logger`, `WDIOReporter` from `@wdio/reporter` —
   plus types from `@wdio/types`.
2. **Service ⇄ BrowserStack backend (network):** Automate via the WebDriver hub (driven by
   `webdriverio` core), plus REST calls (session name, Test Observability/TestHub, funnel
   instrumentation), gRPC (binSession via the `@browserstack/*` SDK), Percy, and the local tunnel.
3. **Service ⇄ user config:** options passed in `services: [['browserstack', {…}]]`.

### 2.6 Dependency graph today

```mermaid
flowchart TD
    BS["@wdio/browserstack-service"]
    subgraph INTERNAL["monorepo-internal (workspace:* → pinned at publish)"]
        T["@wdio/types"]
        R["@wdio/reporter"]
        L["@wdio/logger"]
        W["webdriverio"]
    end
    subgraph EXTERNAL["already external / BrowserStack-owned"]
        BSDK["@browserstack/wdio-browserstack-service"]
        AI["@browserstack/ai-sdk-node"]
        PCY["@percy/*"]
        OTH["undici · chalk · tar · glob · uuid · …"]
    end
    BS --> T & R & L & W
    BS --> BSDK & AI & PCY & OTH
    BS -. "peerDependency" .-> CLI["@wdio/cli"]
    style INTERNAL fill:#fff0f0
```

The four `@wdio/*` / `webdriverio` deps are the only thing tying the package to the monorepo.

---

## 3. The problem

```mermaid
flowchart LR
    A["BrowserStack ships often<br/>(new features, fixes, platform support)"] --> C{"must wait for the<br/>TSC release train"}
    B["WebdriverIO core releases<br/>on its own, slower cadence"] --> C
    C --> D["fixes/features sit unreleased on main"]
    C --> E["BrowserStack can't hotfix independently"]
    C --> F["version number is dictated by the whole monorepo"]
    style C fill:#fff0b3
```

The release cadence mismatch is the entire motivation. Everything else (build, deps) is incidental
plumbing that exists only because the code lives in the monorepo.

---

## 4. What changes — and what explicitly does NOT

| Dimension | Today | After the move | User-visible? |
|---|---|---|---|
| **Install name** | `@wdio/browserstack-service` | **identical** | No |
| **`services: ['browserstack']`** | resolves to the package | **identical** | No |
| **npm scope/owner** | `@wdio` org | **`@wdio` org (unchanged)** | No |
| Source repo | `webdriverio/webdriverio` | `browserstack/wdio-browserstack-service` | No |
| Build | shared `@wdio/compiler` | local esbuild (`scripts/build.mjs`) + `tsc` | No |
| Versioning | Lerna fixed/lockstep | Changesets, independent | Only the version *number* line |
| Release trigger | TSC `workflow_dispatch` | BrowserStack CI on merge | No |
| `@wdio/*` core deps | `dependencies` (`workspace:*`) | **`peerDependencies` (`^9`)** + dev | No (dedupes) |

The one change with real engineering weight is the dependency reclassification:

```mermaid
flowchart LR
    subgraph BEFORE["BEFORE — regular deps, pinned"]
        B1["@wdio/browserstack-service"] --> B2["webdriverio 9.27.2 (own copy)"]
    end
    subgraph AFTER["AFTER — peerDependencies"]
        A1["@wdio/browserstack-service"] -. "peer ^9" .-> A2["webdriverio (the user's copy)"]
        A3["@wdio/cli / webdriverio (user installs)"] --> A2
    end
    BEFORE -->|"avoids a duplicate webdriverio in node_modules"| AFTER
    style AFTER fill:#e6ffe6
```

**Why this matters:** if `webdriverio`/`@wdio/logger`/`@wdio/reporter` were bundled as the service's
own dependency, the user would end up with **two copies** in `node_modules`. That breaks shared
singletons — `instanceof SevereServiceError` checks, the shared logger configuration, the reporter
event bus. Making them **peerDependencies** forces the service to use the **same instances** the user
already has installed. (We confirmed in the PoC that `webdriverio` deduped to a single copy.)

---

## 5. Options we considered, and why we chose this one

```mermaid
flowchart TD
    START{"Move the service out,<br/>keep users unaffected,<br/>release independently"}
    START --> A["A. Own repo,<br/>KEEP @wdio name,<br/>TSC delegates publish"]
    START --> B["B. New scope<br/>@browserstack/wdio-…<br/>+ deprecate old"]
    START --> C["C. Community name<br/>wdio-browserstack-service<br/>(unscoped)"]
    START --> D["D. Stay in monorepo,<br/>make Lerna independent"]

    A --> AV["✅ users unaffected<br/>✅ independent releases<br/>⚠️ needs TSC consent (precedent exists)"]
    B --> BV["✅ full independence<br/>❌ breaks shorthand → users must edit config + reinstall"]
    C --> CV["⚠️ resolves only if user swaps install<br/>❌ @wdio/ wins resolution → not transparent"]
    D --> DV["❌ still TSC-gated workflow → no cadence control"]

    AV --> PICK["CHOSEN: A"]
    style A fill:#e6ffe6
    style PICK fill:#e6ffe6
    style B fill:#fff0f0
    style C fill:#fff0f0
    style D fill:#fff0f0
```

The decision is forced by a chain of hard constraints:

```mermaid
flowchart LR
    G1["Goal: users change NOTHING"] --> R1["⇒ keep publishing as @wdio/browserstack-service"]
    R1 --> R2["npm rule: a scoped package<br/>can't be transferred to another scope"]
    R2 --> R3["⇒ must KEEP the @wdio scope"]
    R3 --> R4["@wdio scope is owned by the WebdriverIO org"]
    R4 --> R5["⇒ TSC must delegate publish rights<br/>(OIDC trusted publishing / per-package access)"]
    style R5 fill:#e6ffe6
```

| Option | Users unaffected? | Independent cadence? | TSC needed? | Verdict |
|---|---|---|---|---|
| **A — own repo, keep `@wdio`, delegated publish** | ✅ | ✅ | yes | **Chosen** |
| B — new `@browserstack` scope + deprecate | ❌ (reinstall + config edit) | ✅ | no | Only if a one-time migration is acceptable |
| C — community unscoped `wdio-…` | ❌ (loses to `@wdio` in resolution) | ✅ | no | Not transparent |
| D — Lerna independent, stay in monorepo | ✅ | ❌ (still one TSC workflow) | yes | Doesn't solve the problem |

**Why A and not B:** B is the classic "rename + `npm deprecate`" playbook (Babel, ESLint, Storybook
addons). It works, but a new scope means `services: ['browserstack']` no longer resolves and every
user must edit `wdio.conf` and reinstall — a direct violation of the "nothing changes" requirement.
A keeps the identity and only moves the plumbing.

**Why A is safe:** it is the **exact** model WebdriverIO already runs for
[`@wdio/visual-service`](https://github.com/webdriverio/visual-testing) (own repo, Changesets,
independent version line) and [`@wdio/electron-service`](https://github.com/webdriverio/desktop-mobile).
Both publish under `@wdio` from repos outside the monorepo.

---

## 6. Target architecture

```mermaid
flowchart TD
    subgraph BSREPO["browserstack/wdio-browserstack-service (public)"]
        SRC2["src/*.ts"]
        BUILD2["scripts/build.mjs (esbuild) + tsc"]
        CS["Changesets (independent versioning)"]
        CI["GitHub Actions: ci.yml + release.yml (OIDC)"]
    end
    subgraph NPMSCOPE["npm @wdio scope (owned by WebdriverIO org)"]
        PKG2["@wdio/browserstack-service<br/>(same name; trusted publisher = this repo)"]
    end
    subgraph USERSIDE["User project (unchanged)"]
        WCONF["wdio.conf services: browserstack"]
        NM["node_modules/@wdio/browserstack-service"]
    end
    SRC2 --> BUILD2 --> CI
    CS --> CI
    CI -->|"npm publish via OIDC"| PKG2
    PKG2 -->|"npm install"| NM
    WCONF -->|"initializePlugin resolves"| NM
    style BSREPO fill:#e8f0ff
    style NPMSCOPE fill:#fff7e6
    style USERSIDE fill:#e6ffe6
```

- **Repo:** BrowserStack-owned, public (provenance requires a public source repo and an exact
  `repository` URL match).
- **Versioning:** Changesets, independent line; compatibility expressed via peer ranges, not version
  parity.
- **Publishing:** npm **Trusted Publishing (OIDC)** — configured once by an `@wdio` org admin to point
  at this repo's `release.yml`. No long-lived npm token is shared with BrowserStack.

---

## 7. Communication model after the move (in depth)

"Communication" happens at four distinct layers. **Layer 1 (runtime) is the one users care about,
and it does not change at all.**

### 7.1 Runtime communication — UNCHANGED

The separately-published package integrates with WebdriverIO **identically** to today, because the
contract is *the npm package name + the service interface + shared peer packages* — none of which
depend on where the source lives.

```mermaid
sequenceDiagram
    participant Conf as wdio.conf
    participant Utils as "@wdio/utils initializePlugin"
    participant NM as node_modules/@wdio/browserstack-service
    participant Runner as "@wdio/cli / @wdio/runner"
    participant Core as webdriverio + @wdio/logger (user's copy)
    participant BS as BrowserStack cloud

    Conf->>Utils: resolve 'browserstack'
    Note over Utils,NM: same package name as always
    Utils->>NM: import @wdio/browserstack-service
    NM-->>Utils: { default: Service, launcher: Launcher }
    Runner->>NM: onPrepare()  → start Local tunnel, init Observability
    NM->>BS: REST/gRPC/tunnel setup
    Runner->>NM: beforeSession / beforeTest / afterTest / after
    NM->>Core: use SevereServiceError, logger (SAME instances via peerDep)
    NM->>BS: update session name, send results
    Runner->>NM: onComplete() → stop tunnel, flush funnel
```

The **peerDependency** design is what makes "same instances" true: the service binds to the
`webdriverio`/`@wdio/logger`/`@wdio/reporter`/`@wdio/types` the user already installed, so there is no
duplicate-copy drift. This is communication **within one Node process** — repo location is irrelevant.

### 7.2 Build-time / compatibility communication — a one-way dependency on published `@wdio/*`

```mermaid
flowchart LR
    subgraph WDIO["webdriverio/webdriverio (publishes core)"]
        CORE3["@wdio/types · @wdio/reporter · @wdio/logger · webdriverio"]
    end
    subgraph BSREPO3["browserstack/wdio-browserstack-service"]
        DEV["devDependencies: ^9 (to build & test)"]
        PEER["peerDependencies: ^9 (what users must have)"]
        MATRIX["CI matrix: test against multiple webdriverio majors"]
    end
    CORE3 -->|"published to npm"| DEV
    CORE3 -->|"published to npm"| PEER
    CORE3 --> MATRIX
```

- The new repo consumes core packages **from npm** (as published by the monorepo) — a clean, one-way
  dependency. There is no reverse dependency: the monorepo never needs the service to build.
- **Compatibility is communicated through the peer range** (`^9.0.0`). When core ships a breaking
  major, BrowserStack widens/bumps the peer range and proves it with a CI matrix. This replaces the
  monorepo's implicit "everything is the same version" guarantee.

### 7.3 Release / publish communication — the OIDC handshake

Publishing under `@wdio` from a BrowserStack repo uses **OpenID Connect trusted publishing**. No
secret is shared; the npm registry verifies the GitHub-signed identity against a per-package config.

```mermaid
sequenceDiagram
    participant Merge as Merge to main (BrowserStack repo)
    participant GHA as GitHub Actions (release.yml)
    participant OIDC as GitHub OIDC provider
    participant NPM as npm registry
    participant Cfg as "@wdio/browserstack-service trusted-publisher config (set once by @wdio admin)"

    Merge->>GHA: Changesets → version bump + build
    GHA->>OIDC: request signed OIDC token (id-token: write)
    OIDC-->>GHA: token { repo, workflow, ref }
    GHA->>NPM: npm publish --provenance (presents OIDC token)
    NPM->>Cfg: does token.repo/workflow match the configured trusted publisher?
    Cfg-->>NPM: match ✅
    NPM-->>GHA: published @wdio/browserstack-service@<new> (with provenance)
```

- **One-time setup (TSC/@wdio admin):** add a trusted publisher to the `@wdio/browserstack-service`
  package pointing at `browserstack/wdio-browserstack-service` + `release.yml`. (Alternative: grant a
  BrowserStack npm account per-package write access.)
- **Ongoing (BrowserStack):** every merge can publish autonomously — no human in the loop, no shared
  token, provenance attached.

### 7.4 Organizational communication — who talks to whom, and when

```mermaid
flowchart TD
    TSC["WebdriverIO TSC / @wdio org admin"]
    BS2["BrowserStack maintainers"]
    NPMORG["npm @wdio org (scope owner)"]
    DOCS["webdriver.io docs + 3rd-party/services.json"]

    BS2 -->|"1. proposal / RFC discussion (once)"| TSC
    TSC -->|"2. configure trusted publisher (once)"| NPMORG
    BS2 -->|"3. publish releases (ongoing, autonomous)"| NPMORG
    BS2 -->|"4. notify on breaking/major changes"| TSC
    BS2 -->|"5. keep docs entry current"| DOCS
    TSC -->|"announce core breaking majors"| BS2
```

- **Once:** proposal + the trusted-publisher/access setup.
- **Ongoing & autonomous:** BrowserStack publishes whenever it wants.
- **Coordination only when needed:** core breaking majors (peer-range updates), docs changes, and
  security contacts. Day-to-day, the two projects are decoupled.

### 7.5 What happens on divergence / failure

| Scenario | How it's handled |
|---|---|
| Core ships a breaking major (e.g. v10) | BrowserStack updates the peer range + CI matrix, releases a compatible version on its own schedule. |
| A user pins an old service version | Works exactly as today — npm resolves the pinned version; the peer range guards compatibility. |
| BrowserStack needs an urgent hotfix | Merge + autonomous publish in minutes — no TSC dependency (the whole point). |
| TSC revokes/changes publish access | Releases pause until reconfigured; the already-published versions keep working for users. |
| Provenance/repo mismatch | Publish fails fast in CI (repo URL must match exactly); no bad artifact reaches users. |

---

## 8. What we validated (proof, not theory)

```mermaid
flowchart LR
    S1["npm install (640 pkgs)<br/>no monorepo, no workspace"] --> S2["npm run build<br/>(no @wdio/compiler)"]
    S2 --> S3["npm pack → tarball"]
    S3 --> S4["install into sample AS<br/>@wdio/browserstack-service"]
    S4 --> S5["webdriverio deduped<br/>(peerDep fix ✅)"]
    S5 --> S6["services: browserstack<br/>resolves via initializePlugin"]
    S6 --> S7["REAL BrowserStack session<br/>ran + test PASSED ✅"]
    style S7 fill:#e6ffe6
```

See [`EXTRACTION.md`](../EXTRACTION.md) for the detailed results, including the unit-test status
(every file passes in isolation; the all-at-once suite needs a teardown tweak owned by the team).

---

## 9. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Duplicate `webdriverio` in user trees | Low | Core packages are `peerDependencies` (validated: deduped). |
| `services:['browserstack']` stops resolving | Very low | Never change the name/scope; integration-test the shorthand each release. |
| Service breaks on a new core major | Medium | CI matrix across `webdriverio` majors; peer range as the contract. |
| Provenance publish fails | Low | `repository` URL matches exactly; repo is public. |
| TSC won't delegate | Low | Strong precedent (visual/electron); fallback is Option B with a migration. |
| Version-number confusion (service vs core) | Low | Document independence; compatibility is the peer range, not the number. |

---

## 10. Glossary

- **Lerna fixed mode** — all monorepo packages share one version, bumped together.
- **`workspace:*`** — pnpm protocol that symlinks a sibling package locally; resolved to a concrete
  version at publish.
- **`initializePlugin`** — the `@wdio/utils` function that maps `services: ['x']` to a package by
  naming convention (`@wdio/x-service` then `wdio-x-service`), importing what's installed.
- **peerDependency** — a dependency the *consumer* must provide, so a single shared copy is used.
- **Trusted publishing (OIDC)** — publishing to npm using a short-lived, GitHub-signed identity instead
  of a long-lived token; configured per package.
- **Provenance** — a signed attestation linking a published artifact to the exact repo/commit/workflow
  that built it.
