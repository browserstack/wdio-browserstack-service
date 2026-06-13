/**
 * Standalone build for @wdio/browserstack-service.
 *
 * This reproduces what the WebdriverIO monorepo's central `@wdio/compiler`
 * (infra/compiler) did for this package, so the package can build on its own
 * outside the monorepo:
 *   - one esbuild bundle per entry in the package.json "exports" map
 *     (`.` -> build/index.js, `./cleanup` -> build/cleanup.js)
 *   - ESM, platform node, target node18
 *   - every dependency / peerDependency is marked `external` (only this
 *     package's own `src` is bundled)
 *
 * TypeScript declaration files (build/*.d.ts) are emitted separately by
 * `tsc -p tsconfig.prod.json` (see the "build" script in package.json).
 */
import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import path from 'node:path'
import url from 'node:url'
import { build, context } from 'esbuild'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, '..')
const pkg = JSON.parse(await readFile(path.resolve(pkgRoot, 'package.json'), 'utf-8'))

const watch = process.argv.includes('--watch')
const isProd = process.env.NODE_ENV === 'production'

/**
 * everything that is NOT this package's own source stays external, exactly like
 * the monorepo compiler's getExternal()
 */
const external = [
    'virtual:*',
    ...builtinModules,
    ...builtinModules.map((mod) => `node:${mod}`),
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {})
]

/**
 * derive entrypoints from the package "exports" map so this stays in sync if a
 * new subpath export is added
 */
const entries = Object.values(pkg.exports || {})
    .filter((exp) => exp && typeof exp === 'object' && typeof exp.import === 'string')
    .map((exp) => {
        const source = exp.source || (exp.import === pkg.exports['.'].import ? './src/index.ts' : exp.import)
        return {
            entry: path.resolve(pkgRoot, source.replace(/^\.\//, '')),
            outfile: path.resolve(pkgRoot, exp.import.replace(/^\.\//, ''))
        }
    })

// the main "." export has no explicit "source" field -> defaults to src/index.ts
entries[0] = { entry: path.resolve(pkgRoot, 'src/index.ts'), outfile: path.resolve(pkgRoot, 'build/index.js') }

const configs = entries.map(({ entry, outfile }) => ({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    sourcemap: isProd ? false : 'inline',
    sourceRoot: pkgRoot,
    tsconfig: path.resolve(pkgRoot, 'tsconfig.json'),
    external,
    logLevel: 'info'
}))

if (watch) {
    await Promise.all(configs.map(async (config) => {
        const ctx = await context(config)
        await ctx.watch()
    }))
    console.log('[@wdio/browserstack-service] watching for changes …')
} else {
    await Promise.all(configs.map(async (config) => {
        const result = await build(config)
        if (result.errors.length > 0) {
            console.error(result.errors)
            process.exit(1)
        }
    }))
    console.log('[@wdio/browserstack-service] esbuild bundle complete → build/index.js, build/cleanup.js')
}
