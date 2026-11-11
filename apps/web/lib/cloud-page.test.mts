import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The test runner (plain `node --test`) cannot import app .tsx modules:
// node's type-stripping rejects JSX and tsx's ESM hooks hit a require(esm)
// cycle on this host's node. So read the page module's source and evaluate
// the exported object literals instead - removing or flipping the robots
// noindex in app/cloud/page.tsx still fails these assertions.
const pageSource = readFileSync(
  fileURLToPath(new URL('../app/cloud/page.tsx', import.meta.url)),
  'utf8',
)

function exportedObjectLiteral(name: string): Record<string, unknown> {
  const marker = `export const ${name}`
  const start = pageSource.indexOf(marker)
  assert.notEqual(start, -1, `app/cloud/page.tsx must export "${name}"`)
  const brace = pageSource.indexOf('{', start)
  assert.notEqual(brace, -1, `exported "${name}" must be an object literal`)
  let depth = 0
  for (let i = brace; i < pageSource.length; i++) {
    if (pageSource[i] === '{') depth++
    else if (pageSource[i] === '}') {
      depth--
      if (depth === 0) {
        const body = pageSource.slice(brace + 1, i)
        // Object literal is static data only (strings/booleans/nested).
        return new Function(`"use strict"; return ({${body}});`)() as Record<string, unknown>
      }
    }
  }
  throw new Error(`unterminated object literal for "${name}"`)
}

test('cloud placeholder page metadata is noindex and no-follow', () => {
  const metadata = exportedObjectLiteral('metadata')
  assert.deepEqual(metadata.robots, { index: false, follow: false })
})

test('cloud placeholder page stays force-dynamic', () => {
  assert.match(pageSource, /^export const dynamic = 'force-dynamic'$/m)
})
