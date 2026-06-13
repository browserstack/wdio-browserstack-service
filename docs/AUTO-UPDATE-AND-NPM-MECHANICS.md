# Auto-update feasibility & npm distribution mechanics

> Companion to [THREE-APPROACHES-ANALYSIS.md](./THREE-APPROACHES-ANALYSIS.md).
> It answers one recurring question in depth: **can we ship updates to the service code on
> BrowserStack's own cadence — ideally auto-updating for customers — *without* publishing a new npm
> release every time, and without breaking customers' installs?**
>
> The short answer: **true "auto-update without a release" is not safely achievable on npm.** The npm
> client is built to make "the version you locked is the code you run" a hard guarantee, and every
> mechanism that tries to get around it either breaks installs (`EINTEGRITY`) or trades away the
> safety net that makes the package trustworthy. The findings below are **verified empirically**
> against npm `10.9.0` / Node `22.11.0`.

---

## 0. TL;DR

| Question | Answer |
|---|---|
| Can a **URL/CDN dependency** float to "latest" and auto-update? | **No** — a moving URL breaks `npm ci`/`npm install` with `EINTEGRITY` for anyone with a committed lockfile. |
| Does a **redirect** (`latest` → versioned) avoid that? | **No** — npm pins the *requested* URL + the content hash; flipping the redirect still mismatches. |
| Can a **caret range** (`^2`) point at a CDN/URL core? | **No** — semver ranges require a registry to enumerate versions. A URL has no version list. |
| Can the package **fetch its core itself** (postinstall/runtime) to dodge `EINTEGRITY`? | **Yes, mechanically** — but it breaks under `--ignore-scripts`/pnpm defaults, loses provenance & reproducibility, and is the supply-chain-attack shape. |
| Does **Approach B (Registry Shim)** hit any of these? | **No** — B has no install scripts, stays reproducible (core pinned in the lockfile), works in air-gapped/mirrored CI, and keeps provenance. Its only cost is mild, *recorded* version skew. |
| Cleanest way to get BrowserStack-cadence releases + auto-update + reproducibility + provenance | **Approach A (Direct Publish) + OIDC trusted publishing** (caret on a normal npm package). |

---

## 1. How npm treats a URL / tarball dependency (verified)

A dependency written as a tarball URL, e.g.

```jsonc
"dependencies": { "wdio-bs-core": "https://cdn.example.com/wdio-bs-core-9.27.3.tgz" }
```

resolves and locks like this in `package-lock.json`:

```jsonc
"node_modules/wdio-bs-core": {
  "resolved":  "https://cdn.example.com/wdio-bs-core-9.27.3.tgz", // the literal URL you wrote
  "integrity": "sha512-…",                                        // hash of the CONTENT it fetched
  "version":   "9.27.3"                                           // read from the tarball's package.json
}
```

The crucial fact: **npm records the content hash and enforces it on every clean install.** This is
npm's supply-chain protection — "the bytes you locked are the bytes you get, forever."

## 2. Why a hosted-core (Approach C) cannot auto-update

### 2a. A mutable URL breaks installs
If the same URL (`…/core-latest.tgz`) is overwritten with new content to "push" an update:

- `npm ci` → **`EINTEGRITY` failure** (locked hash ≠ new content). *Verified.*
- `npm install` with an existing lockfile → **also `EINTEGRITY`** (it does not silently update). *Verified.*
- Only a **fresh install with no lockfile** picks up the new content. *Verified.*

So a mutable URL doesn't "auto-update" — it **bricks installs** for everyone with a committed
lockfile (i.e. essentially all CI).

### 2b. A redirect does not help
Pointing `…/core-latest.tgz` at a `302` redirect to an immutable versioned tarball, then flipping the
redirect target, fails identically: npm locks the **requested** URL and the **content hash** of what
it fetched, not the redirect destination. Flipping the redirect → `EINTEGRITY`. *Verified.*

### 2c. A pinned, immutable URL works — but updates are manual
```jsonc
"dependencies": { "wdio-bs-core": "https://cdn.example.com/wdio-bs-core-9.27.3.tgz" }
```
- `npm install` and `npm ci` are reproducible (immutable artifact, stable hash). *Verified.*
- To upgrade, **the customer edits the URL** to `…-9.28.0.tgz`. *Verified.*

This is real "version tracking via a URL the customer changes" — but it is **explicit/manual**, not
auto, and the customer's `package.json` now contains a URL instead of a semver range.

### 2d. Caret/semver cannot target a URL
`^2.0.0` means "ask the registry for the newest version matching this rule." A URL has no version
list for npm to query, so **semver ranges are registry-only**. Auto-update fundamentally requires a
registry (npm, or a private npm-compatible registry) — static object storage cannot provide it.

> The only non-registry sources npm can apply a semver range to are **git** (`git+https://…#semver:^2`,
> matching git tags) and a **private npm-compatible registry** — neither is static CDN/object storage.

## 3. The "fetch the core ourselves" variant (and why `EINTEGRITY` disappears)

`EINTEGRITY` only applies to artifacts npm puts in the lockfile. If the package keeps its published
bytes fixed and **downloads the real core itself** — via a `postinstall` script or at runtime — into a
cache directory *outside* npm's dependency graph, then **npm never records an integrity hash for the
core**, so it can change freely with **no `EINTEGRITY`**. This is exactly how Puppeteer / Cypress /
Playwright fetch their browser binaries.

**This works mechanically. Verified end-to-end:**

| Step | Result |
|---|---|
| Stable thin package on npm; `postinstall` downloads core v1 from the host | ✅ service runs **core 1.0.0**; lockfile records **only** the thin package (stable hash) — core not tracked |
| Host's core overwritten to v2; customer runs strict **`npm ci`** (unchanged `package.json`/lockfile) | ✅ **no `EINTEGRITY`**; postinstall re-runs; service now runs **core 2.0.0** |
| Same install with **`--ignore-scripts`** | ❌ **`MODULE_NOT_FOUND`** — core never downloaded; service broken |

But avoiding `EINTEGRITY` this way removes the safety net rather than the problem. Four consequences:

1. **Breaks for a large set of users — hard.** `--ignore-scripts` is common in enterprise CI, and
   **pnpm blocks dependency lifecycle scripts by default (v10+) and quarantines fresh releases (v11)**.
   For all of them the core never downloads → the service fails to load. *(Fetching at runtime instead
   of postinstall dodges script-blocking, but then air-gapped/proxy CI breaks at test time and it
   becomes runtime remote-code execution — worse optics.)*
2. **It is the supply-chain-attack pattern.** "Official package auto-fetches + executes remote vendor
   code at install/runtime" is the shape security tooling now actively flags and blocks, and it loses
   npm **provenance** entirely. A host compromise would run unverified code in every customer's CI with
   nothing to catch it.
3. **Maximum, *unrecorded* version skew — the killer for a test tool.** The lockfile says `9.27.3`
   forever while the code that runs changes underneath, with **no record anywhere of what executed**.
   The same pinned version behaves differently on different days → flaky, unexplained results, nothing
   to bisect, nothing to cite in a bug report. The version is fully decoupled from the code.
4. **Air-gap / proxy / offline CI** can't reach the host at install or runtime → broken.

### Hardening (and why it removes the auto-update)
If built anyway, the responsible form is essentially the Puppeteer model plus signing:
- **Sign the hosted payload** (e.g. cosign/minisign) and verify signature + expected version before
  loading — non-negotiable; it restores the integrity given up by leaving npm's graph.
- **Bundle a working core in the package** as a fallback so `--ignore-scripts`/air-gap degrade to the
  shipped code instead of crashing.
- **Log the running core version at startup** so support knows what actually ran.
- **Fetch at runtime with a cache**, not postinstall, to survive script-blocking.

Note the trap: every step that makes this safe — **sign + pin the core to the release + bundle a
fallback** — also **removes the auto-update** and converges back to "ship the code / release per
version." The only variant that *truly* auto-updates is the unsigned fetch-latest one, which is
exactly what scanners and pnpm defaults block.

## 4. Does Approach B (Registry Shim) hit any of these?

No. B is the thin `@wdio/browserstack-service` re-exporting `@browserstack/wdio-browserstack-service`
(both normal npm packages) via a caret range. Issue by issue:

| Issue | Hosted-core internal-fetch | **B. Registry Shim** |
|---|---|---|
| `EINTEGRITY` | avoided only by leaving npm's graph | **N/A** — both are normal registry packages; lockfile pins both with integrity; registry tarballs are immutable → never mismatch |
| `--ignore-scripts` / pnpm script-blocking | ❌ breaks (verified `MODULE_NOT_FOUND`) | **✅ no install scripts at all** — pure resolution + `export *` |
| Supply-chain pattern / scanner flags / provenance | ❌ flagged; no provenance; remote-code channel | **✅ clean** — ordinary public package; no fetch/exec/obfuscation; **npm provenance available** |
| Reproducibility / version skew | ❌ worst case — code changes with no record; non-reproducible | ⚠️ **mild & recorded** — core pinned in the lockfile (exact version + integrity); `npm ci` reinstalls the same code; `npm ls` shows what ran |
| Air-gap / proxy / mirror-only CI | ❌ needs the host reachable | **✅ works** — both packages flow through the npm registry / mirror |

**Why B stays clean:**
- **No install/runtime scripts** — nothing for `--ignore-scripts` or pnpm to disable.
- **Everything stays in the lockfile** — caret resolves *once* to e.g. `2.5.0`, written to the lockfile
  with integrity; thereafter `npm ci` reinstalls exactly `2.5.0` from the immutable registry tarball →
  fully reproducible. The running code is always pinned and visible.
- **Works through corporate mirrors** — no external host; both packages use the registry customers
  already proxy.

**B's only residual is *numeric* skew** (the public `@wdio…@9.x` number ≠ the core `@browserstack…@X.y`
number). Unlike the hosted-fetch model this skew is **recorded and reproducible**, and is tamed by:
align the core's number with the public number · log the running core version at startup · commit
lockfiles. See [version-skew handling in ARCHITECTURE-shim-model.md](./ARCHITECTURE-shim-model.md).

**B's own distinct considerations** (not shared with the hosted model): the `@browserstack/wdio-browserstack-service`
name is in use by another SDK today (needs a new name or a deliberate major bump); the core must keep
`webdriverio`/`@wdio/*` as **peerDependencies** to avoid a duplicate `webdriverio` copy (which would
break `instanceof SevereServiceError`, the shared logger, and the reporter bus); and a major range bump
(`^2`→`^3`) still needs a TSC-approved shim PR (minors/patches flow freely via caret).

## 5. Recommendation

- **True auto-update without an npm release is not safely possible** — not via URL deps (§2) and not
  via internal fetch (§3). The legitimate internal-fetch pattern pins its payload to the release, so a
  release is published per version regardless.
- For **BrowserStack-cadence releases + customers unchanged + lockfile-safe + auto-update + provenance**,
  the only approach that delivers all of it is **A (Direct Publish) + OIDC trusted publishing**: caret
  on a normal npm package *is* the auto-update; npm gives reproducibility + provenance; OIDC removes the
  per-release TSC step.
- **B (Registry Shim)** is a clean fallback — it avoids every dangerous failure mode above; its only
  cost is mild, recorded version skew.
- **Hosted-core / internal-fetch** is justified **only** if the driver is keeping the core
  proprietary/obfuscated — and even then it must be signed + pinned + given a bundled fallback, which
  means releasing per version anyway. **Auto-update is not a reason to choose it.**

---

## Appendix — reproducing the experiments

All results above were produced with **npm `10.9.0` / Node `22.11.0`** using a local HTTP server that
serves tarballs (an immutable-CDN stand-in; npm treats `https://…tgz` and `file:…tgz` deps identically):

1. **URL dep lockfile shape (§1):** declare `"<core>": "http://localhost:PORT/core.tgz"`, `npm install`,
   inspect `package-lock.json` → `resolved` + `integrity` + `version`.
2. **Mutable URL (§2a):** install (locks v1 hash) → overwrite the served tarball with v2 → `npm ci` →
   `EINTEGRITY`. Then `npm install` → `EINTEGRITY`. Then delete the lockfile + `npm install` → v2.
3. **Redirect (§2b):** serve `core-latest.tgz` as `302` → `core-1.0.0.tgz`; install; flip the `302` to
   `core-2.0.0.tgz`; `npm ci` → `EINTEGRITY`.
4. **Pinned URL (§2c):** depend on `…/core-1.0.0.tgz`; `npm install` + `npm ci` reproducible; edit the
   dep to `…/core-2.0.0.tgz` → `npm install` picks up v2.
5. **Internal fetch (§3):** a stable thin package whose `postinstall` downloads the core into `./core`;
   `npm install` runs core v1; overwrite the served core with v2; `npm ci` → **passes**, runs v2 (no
   `EINTEGRITY`); `npm ci --ignore-scripts` → `MODULE_NOT_FOUND`.

### References
- Node.js removed `--experimental-network-imports` (runtime `import()` of `https://` URLs) for security:
  https://github.com/nodejs/node/pull/53822
- Playwright pins browser binaries to each package release: https://playwright.dev/docs/browsers
- Cypress binary download / global cache model: https://docs.cypress.io/app/references/advanced-installation
- pnpm supply-chain defaults (lifecycle-script blocking, minimum release age / quarantine):
  https://pnpm.io/supply-chain-security
