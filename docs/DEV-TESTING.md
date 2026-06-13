# Manual dev-testing guide — `@wdio/browserstack-service`

How to make a change to this package and verify it end-to-end against a real
BrowserStack session, locally, before releasing.

## The pieces (don't confuse them)

| Thing | npm name | Repo | Role |
|---|---|---|---|
| **The plugin (this repo)** | `@wdio/browserstack-service` | this repo | what you edit/test |
| gRPC/protobuf SDK | `@browserstack/wdio-browserstack-service` | `browserstack/wdio-browserstack-service` | a **dependency** (uses `buf`); unchanged unless you're testing SDK changes |
| Sample/consumer project | *(anything, e.g. `bs-sample`)* | throwaway | loads the plugin via `services: ['browserstack']` |

You dev-test by **building the plugin → installing it into a sample WDIO project → running a real session**.

---

## The dev-test loop (overview)

```
edit src/  →  build (esbuild + tsc)  →  put it into a sample project  →  run wdio  →  inspect
                                         (link = fast | tarball = faithful)
```

- **Unit logic?** run Vitest in this repo (fast, no cloud).
- **Behavior / integration?** install into a sample project and run a real BrowserStack session.

---

## 0. Prerequisites
- Node **20.11.1+** (WDIO **v9**; the v8 line uses Node 16). This repo has an `.nvmrc`.
- BrowserStack creds: `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY`.

## 1. Build the plugin
```bash
cd wdio-browserstack-service
nvm use                 # or: nvm install 20.11.1
npm install
npm run build           # esbuild → build/index.js + build/cleanup.js ; tsc → build/*.d.ts
```
Optional unit tests:
```bash
npm test                              # full Vitest suite
# NOTE: the all-at-once suite can hang on a teardown issue (tracked); a single file is reliable:
npx vitest run tests/util.test.ts
```

## 2. Create a sample WDIO project (once)
```bash
mkdir bs-sample && cd bs-sample
npm init -y
npm pkg set type=module
npm i -D @wdio/cli @wdio/local-runner @wdio/mocha-framework @wdio/globals webdriverio
mkdir -p test
```

`bs-sample/wdio.conf.js`:
```js
export const config = {
  runner: 'local',
  user: process.env.BROWSERSTACK_USERNAME,
  key: process.env.BROWSERSTACK_ACCESS_KEY,
  hostname: 'hub.browserstack.com', port: 443, protocol: 'https', path: '/wd/hub',
  // the plugin is referenced ONLY by the shorthand — WDIO resolves it to whatever
  // is installed as @wdio/browserstack-service (i.e. YOUR build).
  services: [['browserstack', {
    // toggle the feature you're testing:
    testObservability: true,
    // browserstackLocal: true,
    // accessibility: true,
  }]],
  capabilities: [{
    browserName: 'chrome',
    'bstack:options': { os: 'Windows', osVersion: '11', buildName: 'dev-test', sessionName: 'dev-test' }
  }],
  framework: 'mocha',
  specs: ['./test/**/*.e2e.js'],
  mochaOpts: { timeout: 90000 },
  logLevel: 'info'
}
```

`bs-sample/test/sample.e2e.js`:
```js
import { browser, expect } from '@wdio/globals'
describe('dev test', () => {
  it('runs on BrowserStack', async () => {
    await browser.url('https://webdriver.io/')
    await expect(browser).toHaveTitle(expect.stringContaining('WebdriverIO'))
  })
})
```

## 3. Put YOUR build into the sample — pick a loop

### Loop A — fast iteration (`npm link`)
```bash
# in the plugin repo:
npm run build:watch &     # rebuilds build/ on every src change
npm link                  # registers @wdio/browserstack-service (symlink)
# in bs-sample:
npm link @wdio/browserstack-service
```
Edit `src/` → watcher rebuilds → re-run the sample. Best for rapid logic changes.

> ⚠️ **Caveat:** with `npm link`, Node follows the symlink and resolves the plugin's
> `webdriverio`/`@wdio/*` **peers from the plugin repo's own `node_modules`**, not the
> sample's — so a *duplicate* `webdriverio` can appear. That means **`link` does NOT
> faithfully test the peerDependency behavior.** Use it for logic; confirm with Loop B.

### Loop B — faithful (tarball) — use before you trust a change
```bash
# in the plugin repo:
npm run build && npm pack --pack-destination /tmp
#   → /tmp/wdio-browserstack-service-<version>.tgz
# in bs-sample:
npm i /tmp/wdio-browserstack-service-<version>.tgz
```
Installs **exactly what would be published** (honours `.npmignore`, `exports`, and
peerDependencies — no duplicate `webdriverio`). Re-pack + re-install on each change.

## 4. Run a real BrowserStack session
```bash
cd bs-sample
BROWSERSTACK_USERNAME=xxx BROWSERSTACK_ACCESS_KEY=yyy npx wdio run wdio.conf.js
```
Watch for `@wdio/browserstack-service` logs (service started, Local tunnel, TestHub) and
the `automate.browserstack.com/builds/...` session link in the output.

## 5. Confirm you're actually running YOUR build (not the published one)
```bash
# from bs-sample:
ls -l node_modules/@wdio/browserstack-service          # link loop → symlink to your repo; tarball loop → real dir
node --input-type=module -e "console.log(import.meta.resolve('@wdio/browserstack-service'))"   # run from inside bs-sample
npm ls webdriverio                                     # should show exactly ONE copy (peerDep working)
```
For an unmistakable check, temporarily add `console.log('MY BUILD')` at the top of
`src/index.ts`, rebuild, and confirm it prints during the run — then remove it.

## 6. Exercise the feature areas
Toggle options in `wdio.conf.js` to hit different code paths:
- **Local tunnel:** `browserstackLocal: true` (+ point the test at a local URL/server)
- **Test Observability / TestHub:** `testObservability: true`
- **Accessibility:** `accessibility: true` (Chrome only)
- **Percy:** Percy config + `PERCY_TOKEN`
- **App Automate:** an `app` capability
- **Multiremote:** capabilities as an object of named browsers

## Gotchas
- **ESM-only** — the sample must be `"type": "module"`.
- **Node** — v9 needs Node ≥20; using 16.x targets the v8 line.
- **Rebuild after edits** — `build:watch` for Loop A; re-pack for Loop B.
- **Duplicate `webdriverio`** — verify with `npm ls webdriverio`; if `link` shows two, that's the symlink caveat (use Loop B to validate peers).
- **Fast feedback for pure logic** — prefer Vitest in this repo over a cloud run.
