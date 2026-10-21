// Confirms that a CI job tests the WebdriverIO major version that it claims to test.
//
// The service supports WebdriverIO 9 and 10, and ci.yml runs the tests once for each major.
// `npm ci` installs the WebdriverIO 10 dev dependencies from the lockfile. The WebdriverIO 9 job then
// replaces them with `npm install --no-save ...@^9`. If that install keeps a v10 copy, or leaves a
// mix of v9 and v10 packages, the job still passes, but it tests the wrong version. This script
// fails the job in that case, so a green WebdriverIO 9 job means that the tests pass on WebdriverIO 9.
//
// It reads the `npm ls` output of the service, prints each installed version, and fails when a
// package is not on <major>, or when `npm ls` did not list exactly <count> packages (for example,
// a package is missing from the tree).
//
// Usage: npm ls -w @wdio/browserstack-service <packages> --depth=0 --json | node check-wdio-major.mjs <major> <count>
import { readFileSync } from 'node:fs'

const [major, count] = process.argv.slice(2)
const tree = JSON.parse(readFileSync(0, 'utf8'))
const deps = tree.dependencies['@wdio/browserstack-service'].dependencies ?? {}

for (const [name, { version }] of Object.entries(deps)) {
    console.log(`${name}@${version}`)
}
const wrong = Object.values(deps).filter(({ version }) => !version?.startsWith(`${major}.`))
if (wrong.length > 0 || Object.keys(deps).length !== Number(count)) {
    console.error(`Expected ${count} packages on WebdriverIO ${major}`)
    process.exit(1)
}
