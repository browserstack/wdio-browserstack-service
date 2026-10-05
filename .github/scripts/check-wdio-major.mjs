// Fails when the WebdriverIO packages of the service are not on the expected major.
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
