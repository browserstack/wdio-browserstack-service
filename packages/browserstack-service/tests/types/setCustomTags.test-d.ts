// Type-regression guard for SDK-6882.
//
// `browser.setCustomTags(key, value)` works at RUNTIME; the bug was compile-time
// only. The WebdriverIO.Browser augmentation existed internally but was not
// emitted to the package's SHIPPED type entry (`exports["."].types` ->
// build/index.d.ts), so a downstream TypeScript project calling
// `browser.setCustomTags(...)` failed to compile with TS2339
// ("Property 'setCustomTags' does not exist on type 'Browser'").
//
// This fixture is a downstream CONSUMER: its tsconfig resolves
// `@wdio/browserstack-service` through the package's `exports`/`types` map
// (the BUILT declaration), never the internal `src/` types. It must be run
// AFTER a build. If the augmentation stops shipping, `setCustomTags` disappears
// from the public `WebdriverIO.Browser` type and this file fails to compile.
import '@wdio/browserstack-service'

// Base `WebdriverIO.Browser` comes from @wdio/globals/types, exactly as in a
// consumer project; the `setCustomTags` member must arrive via the shipped
// augmentation merged on top.
declare const browser: WebdriverIO.Browser

// Presence + callability + return type on the consumer-facing Browser type.
const pending: Promise<void> = browser.setCustomTags('device-tier', 'gold')
void pending

// Exact public signature: (key: string, value: string) => Promise<void>.
const signature: (key: string, value: string) => Promise<void> = browser.setCustomTags
void signature
