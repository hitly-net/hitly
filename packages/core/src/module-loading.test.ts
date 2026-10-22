import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

// Workspace consumers load this package's TypeScript source directly. Some of
// them (for example the Mastra dev server) leave subpath exports external and
// let Node load the .ts files with its built-in type stripping. Node does not
// guess file extensions, so every relative import here must name its file.

const thisFile = fileURLToPath(import.meta.url)
const srcDir = dirname(thisFile)
const packageDir = dirname(srcDir)
const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, string>
}

const RELATIVE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+|\bexport\s*\*\s*from\s*)['"](\.{1,2}\/[^'"]*)['"]/gm

export function extensionlessRelativeImports(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
    const specifier = match[1]
    if (!/\.(?:ts|tsx|js|mjs|cjs|json)$/.test(specifier)) found.push(specifier)
  }
  return found
}

describe('relative imports in @hitly/core', () => {
  it('detects an extensionless relative import', () => {
    assert.deepEqual(extensionlessRelativeImports("import { a } from './a'\n"), ['./a'])
    assert.deepEqual(extensionlessRelativeImports("export * from \"../b\"\n"), ['../b'])
    assert.deepEqual(extensionlessRelativeImports("const m = await import('./c')\n"), ['./c'])
    assert.deepEqual(extensionlessRelativeImports("import { a } from './a.ts'\n"), [])
    assert.deepEqual(extensionlessRelativeImports("import { x } from 'node:fs'\n"), [])
  })

  it('every relative import names its file', () => {
    const offenders: string[] = []
    for (const file of readdirSync(srcDir)) {
      // Skip this file: its fixtures above are extensionless on purpose.
      if (!/\.tsx?$/.test(file) || join(srcDir, file) === thisFile) continue
      const source = readFileSync(join(srcDir, file), 'utf8')
      for (const specifier of extensionlessRelativeImports(source)) {
        offenders.push(`${file}: ${specifier}`)
      }
    }
    assert.deepEqual(offenders, [], 'add the .ts extension to these imports')
  })
})

describe('package entry points load under plain Node', () => {
  const env = { ...process.env }
  delete env.NODE_OPTIONS

  for (const subpath of Object.keys(packageJson.exports)) {
    const specifier = subpath === '.' ? packageJson.name : `${packageJson.name}${subpath.slice(1)}`
    it(`imports ${specifier}`, () => {
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(specifier)})`,
        ],
        { cwd: packageDir, env, encoding: 'utf8', timeout: 30_000 },
      )
      assert.equal(result.status, 0, `${specifier} failed to load:\n${result.stderr}`)
    })
  }
})
