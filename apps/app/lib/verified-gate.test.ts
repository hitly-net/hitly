/**
 * Unit tests for the unverified-email gate (HITLY_REQUIRE_VERIFIED_EMAIL):
 * flag parsing, the create refusal, the REST refusal shape, the banner
 * decision, and two source-scan guards that keep the enforcement points
 * single-path and keep account-security mail outside the gate.
 *
 * Run with: yarn workspace @hitly/app test
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  EMAIL_NOT_VERIFIED_CODE,
  VerifiedEmailRequiredError,
  assertEmailVerifiedForCreate,
  emailNotVerifiedResponse,
  requireVerifiedEmailGateEnabled,
  shouldShowUnverifiedEmailBanner,
} from './verified-gate'

const originalFlag = process.env.HITLY_REQUIRE_VERIFIED_EMAIL

function withFlag(value: string | undefined, fn: () => void | Promise<void>) {
  return (async () => {
    if (value === undefined) delete process.env.HITLY_REQUIRE_VERIFIED_EMAIL
    else process.env.HITLY_REQUIRE_VERIFIED_EMAIL = value
    try {
      await fn()
    } finally {
      if (originalFlag === undefined) delete process.env.HITLY_REQUIRE_VERIFIED_EMAIL
      else process.env.HITLY_REQUIRE_VERIFIED_EMAIL = originalFlag
    }
  })()
}

afterEach(() => {
  if (originalFlag === undefined) delete process.env.HITLY_REQUIRE_VERIFIED_EMAIL
  else process.env.HITLY_REQUIRE_VERIFIED_EMAIL = originalFlag
})

describe('HITLY_REQUIRE_VERIFIED_EMAIL flag', () => {
  it('defaults OFF: unset and anything not in the on-set does not gate', () => {
    for (const value of [undefined, '', '0', 'false', 'off', 'yes', 'TRUE', '1 ']) {
      withFlag(value, () => {
        assert.equal(requireVerifiedEmailGateEnabled(), false, JSON.stringify(value))
      })
    }
  })

  it('turns ON only for 1 / true / on', () => {
    for (const value of ['1', 'true', 'on']) {
      withFlag(value, () => {
        assert.equal(requireVerifiedEmailGateEnabled(), true, value)
      })
    }
  })
})

describe('assertEmailVerifiedForCreate', () => {
  it('flag OFF: unverified creators pass (current closed-beta behaviour)', () => {
    withFlag(undefined, () => {
      assert.doesNotThrow(() => assertEmailVerifiedForCreate(false))
      assert.doesNotThrow(() => assertEmailVerifiedForCreate(true))
    })
  })

  it('flag ON: unverified is refused with the stable code, verified passes', () => {
    withFlag('1', () => {
      assert.doesNotThrow(() => assertEmailVerifiedForCreate(true))
      try {
        assertEmailVerifiedForCreate(false)
        assert.fail('unverified create must throw')
      } catch (error) {
        assert.ok(error instanceof VerifiedEmailRequiredError)
        assert.equal((error as VerifiedEmailRequiredError).code, EMAIL_NOT_VERIFIED_CODE)
        assert.match(error instanceof Error ? error.message : '', /email_not_verified/)
        assert.match(error instanceof Error ? error.message : '', /[Vv]erify/)
      }
    })
  })
})

describe('emailNotVerifiedResponse (REST/MCP refusal shape)', () => {
  it('answers 403 with the stable code and an instruction', async () => {
    const response = emailNotVerifiedResponse()
    assert.equal(response.status, 403)
    const body = (await response.json()) as { error?: string; message?: string }
    assert.equal(body.error, EMAIL_NOT_VERIFIED_CODE)
    assert.ok(body.message && body.message.length > 0, 'message tells the user what to do')
  })
})

describe('shouldShowUnverifiedEmailBanner', () => {
  it('shows only when gated and unverified', () => {
    assert.equal(shouldShowUnverifiedEmailBanner({ flagEnabled: false, emailVerified: false }), false)
    assert.equal(shouldShowUnverifiedEmailBanner({ flagEnabled: false, emailVerified: true }), false)
    assert.equal(shouldShowUnverifiedEmailBanner({ flagEnabled: true, emailVerified: true }), false)
    assert.equal(shouldShowUnverifiedEmailBanner({ flagEnabled: true, emailVerified: false }), true)
  })
})

const APP_ROOT = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

describe('source-scan guards', () => {
  it('only lib/project-create.ts writes projects/projectApiKeys (every create path is gated)', () => {
    const writers: string[] = []
    for (const file of [...sourceFiles(join(APP_ROOT, 'app')), ...sourceFiles(join(APP_ROOT, 'actions')), ...sourceFiles(join(APP_ROOT, 'lib'))]) {
      if (file.endsWith(`${sep}project-create.ts`)) continue
      if (file.endsWith('m0h-fixture.ts')) continue // test fixture, not a request path
      const source = readFileSync(file, 'utf8')
      if (/\.insert\((projects|projectApiKeys)\)/.test(source)) writers.push(relative(APP_ROOT, file))
    }
    assert.deepEqual(writers, [], 'direct writes to projects/projectApiKeys must stay inside the gated create helpers')
  })

  it('account-security mail modules never reference the gate', () => {
    for (const name of [
      'email-verification-route.ts',
      'email-verification-issue.ts',
      'email-verification-emails.ts',
      'password-reset.ts',
      'password-reset-emails.ts',
      'email-change-route.ts',
    ]) {
      const source = readFileSync(join(APP_ROOT, 'lib', name), 'utf8')
      assert.ok(!source.includes('verified-gate'), `${name} must stay outside the gate: verification/reset mail always sends`)
    }
  })
})
