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

const APP_ROOT = join(__dirname, '..')

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
    for (const value of [undefined, '', '0', 'false', 'off', 'no', 'maybe', 'truex', '1x']) {
      withFlag(value, () => {
        assert.equal(requireVerifiedEmailGateEnabled(), false, JSON.stringify(value))
      })
    }
  })

  it('turns ON for 1 / true / yes / on, trimmed and case-insensitive', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE', '1 ', 'On ', ' YES', '\tTrue\n', 'Yes']) {
      withFlag(value, () => {
        assert.equal(requireVerifiedEmailGateEnabled(), true, JSON.stringify(value))
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

describe('shouldShowUnverifiedEmailBanner (the pure banner decision used by AppShell)', () => {
  it('flag off + unverified: no banner (closed beta shows nothing new)', () => {
    assert.equal(shouldShowUnverifiedEmailBanner({ flagEnabled: false, emailVerified: false }), false)
  })
  it('flag off + verified: no banner', () => {
    assert.equal(shouldShowUnverifiedEmailBanner({ flagEnabled: false, emailVerified: true }), false)
  })
  it('flag on + verified: no banner (verified users see nothing)', () => {
    assert.equal(shouldShowUnverifiedEmailBanner({ flagEnabled: true, emailVerified: true }), false)
  })
  it('flag on + unverified: banner shows', () => {
    assert.equal(shouldShowUnverifiedEmailBanner({ flagEnabled: true, emailVerified: false }), true)
  })
})

describe('AppShell banner wiring (static pins; the async server component is not renderable in the node suite)', () => {
  const appShell = readFileSync(join(APP_ROOT, 'components', 'app-shell.tsx'), 'utf8')

  it('imports the decision helper and the flag reader from the gate module', () => {
    const clause = /import\s+\{([^}]*)\}\s+from\s+'@\/lib\/verified-gate'/.exec(appShell)
    assert.ok(clause, 'AppShell must import from @/lib/verified-gate')
    const names = clause![1]!.split(',').map((n) => n.trim()).filter(Boolean)
    assert.ok(names.includes('shouldShowUnverifiedEmailBanner'), 'the decision comes from the pure helper, not a re-implementation')
    assert.ok(names.includes('requireVerifiedEmailGateEnabled'), 'the flag comes from the shared parser')
  })

  it('derives the render condition from the helper fed with the live flag and the real user flag (kills B1 and B3)', () => {
    // B1 (banner with the flag off) fails: flagEnabled must come from the
    // flag reader, never a constant.
    // B3 (banner for verified users) fails: emailVerified must come from the
    // session user, never a constant.
    assert.match(
      appShell,
      /const\s+(\w+)\s*=\s*shouldShowUnverifiedEmailBanner\(\{[^}]*flagEnabled:\s*requireVerifiedEmailGateEnabled\(\)[^}]*emailVerified:\s*user\.emailVerified[^}]*\}\)/,
      'the condition must be shouldShowUnverifiedEmailBanner({ flagEnabled: requireVerifiedEmailGateEnabled(), emailVerified: user.emailVerified })',
    )
  })

  it('renders the banner exactly when the helper result is true (kills B2)', () => {
    // B2 (never shows) fails: the JSX must render UnverifiedEmailBanner from
    // the helper-assigned condition — no constant, no other gate.
    const wired = /const\s+(\w+)\s*=\s*shouldShowUnverifiedEmailBanner\(/.exec(appShell)
    assert.ok(wired, 'a const must capture the helper result')
    const name = wired![1]!
    const jsx = new RegExp(`\\{\\s*${name}\\s*\\?\\s*<UnverifiedEmailBanner\\s*\\/>\\s*:\\s*null\\s*\\}`)
    assert.match(appShell, jsx, `<${name} ? <UnverifiedEmailBanner /> : null> must be the only gate on the banner`)
  })
})

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
