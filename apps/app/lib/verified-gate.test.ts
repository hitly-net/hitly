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
  VERIFY_TO_CONTINUE_TITLE,
  VerifiedEmailRequiredError,
  assertEmailVerifiedForCreate,
  emailNotVerifiedResponse,
  gateBlockedResult,
  isGateBlockedResult,
  requireVerifiedEmailGateEnabled,
  shouldShowUnverifiedEmailBanner,
  toGateBlockedResult,
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

describe('typed gate-blocked result (S1: no throw, no 500, no error id)', () => {
  it('carries the stable code, error status and a verify-your-email message', () => {
    const result = gateBlockedResult()
    assert.deepEqual(result, {
      status: 'error',
      code: EMAIL_NOT_VERIFIED_CODE,
      message: expect_includes_verify(result.message),
    })
    assert.equal(result.code, 'email_not_verified')
  })

  it('isGateBlockedResult accepts only the typed shape', () => {
    assert.equal(isGateBlockedResult(gateBlockedResult()), true)
    assert.equal(isGateBlockedResult({ status: 'error', code: 'other' }), false)
    assert.equal(isGateBlockedResult({ apiKey: 'hitly_x' }), false)
    assert.equal(isGateBlockedResult(null), false)
    assert.equal(isGateBlockedResult('email_not_verified'), false)
  })

  it('toGateBlockedResult maps ONLY the gate error; every other throw passes through as null', () => {
    assert.deepEqual(toGateBlockedResult(new VerifiedEmailRequiredError()), gateBlockedResult())
    assert.equal(toGateBlockedResult(new Error('Name is required')), null)
    assert.equal(toGateBlockedResult({ digest: 'NEXT_REDIRECT' }), null)
    assert.equal(toGateBlockedResult(undefined), null)
  })

  it('the web headline is the agreed copy', () => {
    assert.equal(VERIFY_TO_CONTINUE_TITLE, 'Verify your email to continue')
  })
})

function expect_includes_verify(message: string): string {
  assert.match(message, /Verify your email/i)
  return message
}

describe('server actions convert a blocked create into the typed result (static pins)', () => {
  const projectsActions = readFileSync(join(APP_ROOT, 'actions', 'projects.ts'), 'utf8')
  const teamActions = readFileSync(join(APP_ROOT, 'actions', 'team.ts'), 'utf8')

  it('project create, key create and key regenerate all catch the gate and return the typed result', () => {
    for (const name of ['createProject', 'createProjectApiKey', 'regenerateProjectApiKey']) {
      const fn = actionBody(projectsActions, name)
      assert.match(fn, /toGateBlockedResult\(error\)/, `${name} must map the gate error onto the typed result`)
      assert.match(fn, /if \(blocked\) return blocked/, `${name} must RETURN the typed state, not rethrow it`)
      assert.match(fn, /throw error/, `${name} must still rethrow every other failure`)
    }
  })

  it('key regenerate rotates through the gated lib chokepoint', () => {
    assert.match(projectsActions, /rotateProjectApiKeyRecord\(\{ projectId, keyId, userId: user\.id \}\)/)
    const lib = readFileSync(join(APP_ROOT, 'lib', 'project-create.ts'), 'utf8')
    const fn = actionBody(lib, 'rotateProjectApiKeyRecord')
    assert.match(fn, /await assertCreatorVerified\(args\.userId\)/, 'regenerate is gated like a create')
  })

  it('invite send and resend catch the gate and return the typed result, and name the actor to the lib', () => {
    for (const name of ['inviteToWorkspace', 'resendInvite']) {
      const fn = actionBody(teamActions, name)
      assert.match(fn, /toGateBlockedResult\(error\)/, `${name} must map the gate error onto the typed result`)
      assert.match(fn, /if \(blocked\) return blocked/, `${name} must RETURN the typed state, not rethrow it`)
    }
    assert.match(teamActions, /actorUserId: user\.id/, 'invites name the acting account to the lib')
    const invites = readFileSync(join(APP_ROOT, 'lib', 'invites.ts'), 'utf8')
    assert.match(invites, /async function createAndSendWorkspaceInvite[\s\S]*?await assertActorEmailVerified\(args\.actorUserId, database\)[\s\S]*?insert\(invites\)/,
      'create path gates BEFORE the invite row is written')
    assert.match(invites, /async function resendWorkspaceInvite[\s\S]*?await assertActorEmailVerified\(args\.actorUserId, database\)[\s\S]*?update\(invites\)/,
      'resend gates BEFORE the token is rotated')
  })
})

function actionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`export async function ${name}\\(`))
  assert.notEqual(start, -1, `${name} must exist as an exported async action`)
  const next = source.indexOf('export async function', start + 10)
  return source.slice(start, next === -1 ? source.length : next)
}
