import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAuthSecret } from './auth'

/**
 * BETTER_AUTH_SECRET handling (lib/auth.ts).
 *
 * Production must fail at startup when the secret is missing; there is no
 * fixed fallback in production. Outside production a clearly-labelled
 * development value keeps tests and local runs working.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('auth secret resolution', () => {
  it('returns the configured secret', () => {
    const secret = 's'.repeat(32)
    assert.equal(resolveAuthSecret({ BETTER_AUTH_SECRET: secret, NODE_ENV: 'production' }), secret)
  })

  it('throws in production when BETTER_AUTH_SECRET is not set', () => {
    assert.throws(() => resolveAuthSecret({ NODE_ENV: 'production' }), /BETTER_AUTH_SECRET/)
  })

  it('uses the dev-only value only outside production', () => {
    const devValue = resolveAuthSecret({ NODE_ENV: 'test' })
    assert.match(devValue, /dev-only/, 'the development fallback must be clearly labelled')
    assert.notEqual(resolveAuthSecret({ NODE_ENV: 'development', BETTER_AUTH_SECRET: 'custom' }), devValue)
  })

  it('does not treat the next build phase as startup', () => {
    const building = resolveAuthSecret({
      NODE_ENV: 'production',
      NEXT_PHASE: 'phase-production-build',
    })
    assert.match(building, /dev-only/, 'page-data collection during build may use the dev-only value')
  })

  it('the auth module wires the resolver instead of an inline fallback', () => {
    const source = fs.readFileSync(path.join(__dirname, 'auth.ts'), 'utf-8')
    assert.match(source, /secret: resolveAuthSecret\(\)/)
    assert.ok(
      !/secret:\s*process\.env\.BETTER_AUTH_SECRET\s*\?\?/.test(source),
      'no inline ?? fallback may remain on the secret option',
    )
  })
})
