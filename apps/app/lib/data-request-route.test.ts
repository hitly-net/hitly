import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

/**
 * Route-surface test for the removal of the self-serve data download and the
 * wiring of the support capture instead.
 *
 * Next.js answers 404 for any path with no route handler, so "the download
 * route is gone with a 404" is proved by proving the route file no longer
 * exists (and no handler for it can be reached): the export route directory,
 * the generator, the zip writer and the download button are all absent, and
 * no source file references them any more (needle strings are assembled from
 * fragments so this scanner never matches itself).
 *
 * Mutant note: restoring app/api/session/export/route.ts (or any reference
 * to the old generator) turns the matching test RED.
 */

const APP_ROOT = join(fileURLToPath(import.meta.url), '..', '..')

const GONE_FILES = [
  join('app', 'api', 'session', 'export'),
  join('app', 'api', 'session', 'export', 'route.ts'),
  join('lib', ['gdpr', 'export'].join('-') + '.ts'),
  join('lib', ['gdpr', 'export'].join('-') + '.test.ts'),
  join('lib', ['gdpr', 'export'].join('-') + '.live.test.ts'),
  join('lib', ['gdpr', 'export'].join('-') + '-limit.ts'),
  join('lib', 'zip.ts'),
  join('lib', 'zip.test.ts'),
  join('components', ['data', 'export', 'button'].join('-') + '.tsx'),
  join('components', ['data', 'export', 'button'].join('-') + '.test.tsx'),
]

// Assembled from fragments so scanning this file cannot match its own needles.
const FORBIDDEN_NEEDLES = [
  ['/', 'api', '/', 'session', '/', 'export'].join(''),
  ['hand', 'leData', 'Export'].join(''),
  ['gdp', 'r-exp', 'ort'].join(''),
  ['data-exp', 'ort-b', 'utton'].join(''),
  ["from './z", 'ip'].join(''),
]

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('self-serve data download is gone (404 by route absence)', () => {
  it('the export route, generator, zip writer and download button are removed', () => {
    for (const gone of GONE_FILES) {
      assert.equal(existsSync(join(APP_ROOT, gone)), false, `${gone} must not exist`)
    }
  })

  it('no source file references the removed download surfaces', () => {
    const self = fileURLToPath(import.meta.url)
    for (const file of sourceFiles(APP_ROOT)) {
      if (file === self) continue
      const text = readFileSync(file, 'utf8')
      for (const needle of FORBIDDEN_NEEDLES) {
        assert.equal(text.includes(needle), false, `${relative(APP_ROOT, file)} still mentions "${needle.slice(0, 8)}…"`)
      }
    }
  })

  it('docs and README no longer advertise a self-serve download', () => {
    assert.equal(existsSync(join(APP_ROOT, '..', '..', 'docs', 'data-export.md')), false)
    const readme = readFileSync(join(APP_ROOT, '..', '..', 'README.md'), 'utf8')
    assert.equal(readme.includes(['data-', 'export'].join('')), false)
    assert.ok(readme.includes('data-request.md'))
  })
})

describe('support capture is wired', () => {
  it('the data-request route delegates to the capture handler', () => {
    const route = readFileSync(join(APP_ROOT, 'app', 'api', 'session', 'data-request', 'route.ts'), 'utf8')
    assert.match(route, /handleDataRequest/)
    assert.match(route, /isSameOrigin/)
    assert.match(route, /isJsonContentType/)
  })

  it('the settings page renders the request button, not a download', () => {
    const page = readFileSync(join(APP_ROOT, 'app', 'settings', 'profile', 'page.tsx'), 'utf8')
    assert.match(page, /DataRequestButton/)
    const button = readFileSync(join(APP_ROOT, 'components', 'data-request-button.tsx'), 'utf8')
    assert.match(button, /UK GDPR/)
    assert.match(button, /one month/)
    assert.doesNotMatch(button, /createObjectURL/)
  })

  it('the new test files are registered in the package test script', () => {
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { scripts: { test: string } }
    for (const file of [
      'lib/data-request.test.ts',
      'lib/data-request.live.test.ts',
      'lib/data-request-route.test.ts',
      'components/data-request-button.test.tsx',
    ]) {
      assert.ok(pkg.scripts.test.includes(file), `${file} registered`)
    }
  })
})
