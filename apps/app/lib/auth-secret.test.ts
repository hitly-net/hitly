import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUTH_SECRET_MIN_LENGTH,
  assertProductionAuthSecret,
  productionAuthSecretProblem,
  resolveAuthSecret,
} from './auth-secret'

/**
 * BETTER_AUTH_SECRET handling (lib/auth-secret.ts, wired in lib/auth.ts and
 * instrumentation.ts).
 *
 * Production requires a trimmed secret of at least 32 characters that is not
 * a documented placeholder; the check runs when auth is configured and again
 * at server start. Outside production a clearly-labelled development value
 * keeps tests and local runs working.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GOOD = 'k'.repeat(AUTH_SECRET_MIN_LENGTH)

describe('auth secret resolution', () => {
  it('returns the configured secret, trimmed', () => {
    assert.equal(resolveAuthSecret({ BETTER_AUTH_SECRET: GOOD, NODE_ENV: 'production' }), GOOD)
    assert.equal(resolveAuthSecret({ BETTER_AUTH_SECRET: `  ${GOOD}\n`, NODE_ENV: 'production' }), GOOD)
  })

  it('throws in production when BETTER_AUTH_SECRET is not set', () => {
    assert.throws(() => resolveAuthSecret({ NODE_ENV: 'production' }), /BETTER_AUTH_SECRET must be set/)
  })

  it('throws in production when BETTER_AUTH_SECRET is empty or whitespace', () => {
    assert.throws(() => resolveAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: '' }), /must be set/)
    assert.throws(() => resolveAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: '   ' }), /must be set/)
  })

  it('requires at least 32 characters in production, after trimming', () => {
    const short = 'k'.repeat(AUTH_SECRET_MIN_LENGTH - 1)
    assert.equal(AUTH_SECRET_MIN_LENGTH, 32)
    assert.throws(() => resolveAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: short }), /at least 32/)
    assert.throws(
      () => resolveAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: `   ${short}   ` }),
      /at least 32/,
      'padding must not count towards the length',
    )
  })

  it('rejects the documented placeholder values in production', () => {
    for (const placeholder of ['dev-only-change-me-please-32ch', 'replace-me-with-a-32-char-secret']) {
      assert.notEqual(productionAuthSecretProblem(placeholder), null, placeholder)
      assert.throws(() => resolveAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: placeholder }))
      assert.throws(() => resolveAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: ` ${placeholder} ` }))
    }
  })

  it('never includes the secret value in the error message', () => {
    const short = 'abc-short-secret'
    assert.throws(
      () => resolveAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: short }),
      (error: Error) => !error.message.includes(short),
    )
  })

  it('uses the dev-only value only outside production', () => {
    const devValue = resolveAuthSecret({ NODE_ENV: 'test' })
    assert.match(devValue, /dev-only/, 'the development fallback must be clearly labelled')
    assert.notEqual(resolveAuthSecret({ NODE_ENV: 'development', BETTER_AUTH_SECRET: 'custom' }), devValue)
  })

  it('has no phase-based exemption in production', () => {
    for (const phase of ['phase-production-build', 'phase-production-server', 'phase-production-build-x', '']) {
      assert.throws(
        () => resolveAuthSecret({ NODE_ENV: 'production', NEXT_PHASE: phase }),
        /BETTER_AUTH_SECRET/,
        `NEXT_PHASE=${JSON.stringify(phase)}`,
      )
    }
  })

  it('loading the auth module does not need the secret; creating the instance does', async () => {
    const env = process.env as Record<string, string | undefined>
    const saved = { NODE_ENV: env.NODE_ENV, DATABASE_URL: env.DATABASE_URL, BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET }
    env.NODE_ENV = 'production'
    // A pool is created lazily and never connects in this test.
    env.DATABASE_URL = 'postgres://user:pass@127.0.0.1:1/unused'
    delete env.BETTER_AUTH_SECRET
    try {
      const { auth } = await import('./auth')
      assert.ok(auth, 'an auth handle exists once a database is configured')
      assert.throws(() => auth.api, /BETTER_AUTH_SECRET must be set/)
      assert.throws(() => 'handler' in auth, /BETTER_AUTH_SECRET must be set/)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete env[key]
        else env[key] = value
      }
    }
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

describe('auth secret check at server start', () => {
  it('passes outside production and with a usable production secret', () => {
    assert.doesNotThrow(() => assertProductionAuthSecret({ NODE_ENV: 'development' }))
    assert.doesNotThrow(() => assertProductionAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: GOOD }))
  })

  it('refuses a missing, short or placeholder secret in production in every phase', () => {
    const phases = [undefined, 'phase-production-server', 'phase-production-build']
    const bad = [undefined, '', 'k'.repeat(31), 'replace-me-with-a-32-char-secret']
    for (const NEXT_PHASE of phases) {
      for (const BETTER_AUTH_SECRET of bad) {
        assert.throws(
          () => assertProductionAuthSecret({ NODE_ENV: 'production', NEXT_PHASE, BETTER_AUTH_SECRET }),
          /refusing to start/,
        )
      }
    }
  })

  it('instrumentation register() refuses to start without a usable secret in production', async () => {
    const env = process.env as Record<string, string | undefined>
    const saved = {
      NODE_ENV: env.NODE_ENV,
      NEXT_RUNTIME: env.NEXT_RUNTIME,
      NEXT_PHASE: env.NEXT_PHASE,
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    }
    env.NODE_ENV = 'production'
    env.NEXT_RUNTIME = 'nodejs'
    env.NEXT_PHASE = 'phase-production-build'
    delete env.BETTER_AUTH_SECRET
    try {
      const { register } = await import('../instrumentation')
      await assert.rejects(() => register(), /BETTER_AUTH_SECRET/)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete env[key]
        else env[key] = value
      }
    }
  })

  it('register() runs the check before anything else starts', () => {
    const source = fs.readFileSync(path.join(__dirname, '../instrumentation.ts'), 'utf-8')
    const check = source.indexOf('assertProductionAuthSecret()')
    assert.ok(check > 0, 'register must call assertProductionAuthSecret')
    assert.ok(check < source.indexOf('startHousekeeping()'), 'the check must run before housekeeping starts')
  })
})
