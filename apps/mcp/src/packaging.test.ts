import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies?: Record<string, string>
}
const yarnLock = readFileSync(new URL('../../../yarn.lock', import.meta.url), 'utf8')

/**
 * GHSA-mrhx-c7xc-m3w5: zod 4.4.3 has a memory-blowup DoS. apps/mcp must pin
 * ^4.6.6 in package.json, the lockfile must carry that descriptor, and the
 * package that actually resolves from this workspace must be >= 4.6.6.
 */
test('apps/mcp pins zod to ^4.6.6 (GHSA-mrhx-c7xc-m3w5) and the lockfile honours it', () => {
  assert.equal(pkg.dependencies.zod, '^4.6.6')
  assert.match(yarnLock, /zod@\^4\.6\.6/)
  const blocks = yarnLock.split('\n\n')
  const block = blocks.find((entry) => /^["'][^"']*zod@\^4\.6\.6[^"']*["']?:|^[^\n]*zod@\^4\.6\.6[^\n]*:$/m.test(entry.split('\n')[0] ?? ''))
  assert.ok(block !== undefined, 'yarn.lock must carry a zod@^4.6.6 block')
  const resolved = /zod\/-\/zod-(\d+)\.(\d+)\.(\d+)\.tgz/.exec(block as string)
  if (resolved === null) throw new Error('the zod@^4.6.6 block must pin a resolved tarball')
  const [major, minor, patch] = resolved.slice(1).map(Number)
  assert.ok(major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6))), `locked zod ${resolved[0]} must be >= 4.6.6`)
  const installed = JSON.parse(readFileSync(require.resolve('zod/package.json'), 'utf8')) as { version: string }
  const [imajor, iminor, ipatch] = installed.version.split('.').map(Number)
  assert.ok(
    imajor > 4 || (imajor === 4 && (iminor > 6 || (iminor === 6 && ipatch >= 6))),
    `resolved zod ${installed.version} must be >= 4.6.6 (GHSA-mrhx-c7xc-m3w5 affects 4.4.3)`,
  )
})

test('apps/mcp has a lint script and a flat eslint config', () => {
  assert.equal(pkg.scripts.lint, 'eslint .')
  assert.ok(existsSync(new URL('../eslint.config.mjs', import.meta.url)), 'eslint.config.mjs must exist for `eslint .`')
  assert.equal(typeof pkg.devDependencies?.eslint, 'string', 'eslint must be a devDependency')
})
