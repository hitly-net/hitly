/**
 * Route-level 429 coverage for every REST /api/v1 limiter family (HG-2 M2).
 *
 * Each test forces the shared limiter to DENY through the test seam, calls
 * the real route handler, and requires: 429 + Retry-After, the expected
 * family + subject at the limiter, and that the route's real work (listing,
 * cancelling, accepting, running jobs) NEVER ran. Removing the applyRestLimit
 * call from any covered route makes that route's test fail.
 *
 * Requires --experimental-test-module-mocks (enabled in the package test script).
 */

import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it, mock } from 'node:test'
import { setRestLimitAcquireOverrideForTests, type RestLimitKind } from './rest-limit'
import { hashApiKey } from './keys'

const KEY = 'hitly_' + 'b'.repeat(32)
const VALID_INVITE = 'valid_invite_token_for_tests'

// ---- mutable fakes (read through closures so tests can steer them) ----

const fakes = {
  authn: { project: { id: 'prj_m2', workspaceId: 'ws_m2' } } as unknown,
  sessionUser: { id: 'usr_m2', name: 'M2', email: 'm2@example.com' } as unknown,
  inviteValid: true,
  lookupOk: true,
  workCalls: [] as string[],
}

mock.module('next/headers', {
  namedExports: {
    headers: async () => new Headers(),
    cookies: async () => ({ get: () => undefined }),
  },
})

mock.module(new URL('./auth.ts', import.meta.url).href, {
  namedExports: {
    auth: { api: { getSession: async () => (fakes.sessionUser ? { user: fakes.sessionUser } : null) } },
  },
})

mock.module(new URL('./approvals.ts', import.meta.url).href, {
  namedExports: {
    authenticateProjectKey: async () => fakes.authn,
    listRequesterPending: async () => {
      fakes.workCalls.push('listRequesterPending')
      return { ok: true, projectId: 'prj_m2', items: [], nextCursor: null }
    },
    cancelApprovalAsRequester: async () => {
      fakes.workCalls.push('cancelApprovalAsRequester')
      return { ok: true, status: 'cancelled' }
    },
    cancelApproval: async () => {
      fakes.workCalls.push('cancelApproval')
      return { ok: true }
    },
    ingestApproval: async () => {
      fakes.workCalls.push('ingestApproval')
      return { ok: false, status: 401, error: 'Invalid API key or project' }
    },
    getApprovalForOrigin: async () => {
      fakes.workCalls.push('getApprovalForOrigin')
      return { ok: true, id: 'apr_m2' }
    },
  },
})

mock.module(new URL('./invites.ts', import.meta.url).href, {
  namedExports: {
    acceptInviteAsUser: async () => {
      fakes.workCalls.push('acceptInviteAsUser')
      return { ok: true, workspaceId: 'ws_m2' }
    },
    acceptInviteWithNewAccount: async () => {
      fakes.workCalls.push('acceptInviteWithNewAccount')
      return { ok: true, workspaceId: 'ws_m2', result: [] }
    },
    emailsMatch: (a: string, b: string) => a === b,
    isWellFormedInviteToken: (token: unknown) => fakes.inviteValid && token === VALID_INVITE,
    lookupInvite: async (token: unknown) => {
      fakes.workCalls.push('lookupInvite')
      return fakes.lookupOk && token === VALID_INVITE
        ? { ok: true, invite: { email: 'invited@example.com', expiresAt: new Date(Date.now() + 60_000) }, workspaceName: 'W' }
        : { ok: false, reason: 'invalid' }
    },
    refusalMessage: (reason: string) => `refused: ${reason}`,
    refusalStatus: (_reason: string) => 400,
  },
})

mock.module(new URL('./invite-signup.ts', import.meta.url).href, {
  namedExports: {
    normaliseEmail: (email: string) => email.trim().toLowerCase(),
  },
})

mock.module(new URL('./cors.ts', import.meta.url).href, {
  namedExports: {
    appOwnOrigin: () => 'http://localhost:3001',
  },
})

mock.module(new URL('./workspace.ts', import.meta.url).href, {
  namedExports: {
    listUserWorkspaces: async () => [{ id: 'ws_m2', name: 'M2 WS', role: 'admin' }],
  },
})

// ---- module imports (inside before(), after the mocks are registered) ----

let sessionGuard: typeof import('./api-session')
let approvalDetailFactory: typeof import('./approval-detail-route')
let inviteHandlers: typeof import('./invite-routes')
let approvalsRoute: typeof import('../app/api/v1/approvals/route')
let byRunIdRoute: typeof import('../app/api/v1/approvals/by-run-id/route')
let cancelRoute: typeof import('../app/api/v1/approvals/[id]/cancel/route')
let housekeepingRoute: typeof import('../app/api/v1/housekeeping/route')
let signupStatusRoute: typeof import('../app/api/v1/signup-status/route')

// ---- limiter seam ----

let seamCalls: Array<{ kind: RestLimitKind; subject: string }> = []

function denySeam(): void {
  seamCalls = []
  setRestLimitAcquireOverrideForTests((kind, subject) => {
    seamCalls.push({ kind, subject })
    return { allowed: false, retryAfterMs: 7_000, count: 999 }
  })
}

afterEach(() => {
  setRestLimitAcquireOverrideForTests(null)
  fakes.workCalls.length = 0
})

before(async () => {
  process.env.HITLY_CRON_SECRET = 'm2-cron-secret'
  sessionGuard = await import('./api-session')
  approvalDetailFactory = await import('./approval-detail-route')
  inviteHandlers = await import('./invite-routes')
  approvalsRoute = await import('../app/api/v1/approvals/route')
  byRunIdRoute = await import('../app/api/v1/approvals/by-run-id/route')
  cancelRoute = await import('../app/api/v1/approvals/[id]/cancel/route')
  housekeepingRoute = await import('../app/api/v1/housekeeping/route')
  signupStatusRoute = await import('../app/api/v1/signup-status/route')
})

after(() => {
  delete process.env.HITLY_CRON_SECRET
})

function expectLimited(kind: RestLimitKind, subject?: string): void {
  assert.ok(seamCalls.length >= 1, 'the limiter was consulted')
  assert.equal(seamCalls[0]!.kind, kind)
  if (subject !== undefined) assert.equal(seamCalls[0]!.subject, subject)
  assert.equal(fakes.workCalls.length, 0, 'the limiter must gate BEFORE the route work')
}

function getJson(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3001${path}`, { headers })
}

function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3001${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3001', ...headers },
    body: JSON.stringify(body),
  })
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

describe('route-level 429 coverage (M2)', () => {
  it('session-authed chokepoint: requireApiSession refuses at the budget', async () => {
    denySeam()
    const result = await sessionGuard.requireApiSession()
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.status, 429)
      assert.equal(result.error.headers.get('retry-after'), '7')
    }
    expectLimited('read', 'usr_m2')
  })

  it('GET /api/v1/approvals (list): hashed key, counted after authentication', async () => {
    denySeam()
    const response = await approvalsRoute.GET(getJson('/api/v1/approvals?projectId=prj_m2', { authorization: `Bearer ${KEY}` }))
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('retry-after'), '7')
    expectLimited('read', hashApiKey(KEY))
  })

  it('GET /api/v1/approvals/by-run-id: hashed key, counted after authentication', async () => {
    denySeam()
    const response = await byRunIdRoute.GET(getJson('/api/v1/approvals/by-run-id?runId=run_m2', { authorization: `Bearer ${KEY}` }))
    assert.equal(response.status, 429)
    expectLimited('read', hashApiKey(KEY))
  })

  it('GET /api/v1/approvals/[id] (MCP get_decision): hashed key, counted after authentication', async () => {
    denySeam()
    const GET = approvalDetailFactory.createApprovalDetailGet({
      requireApiWorkspace: async () => ({ ok: false as const, error: new Response(null, { status: 401 }) }) as never,
      getApprovalDetail: (async () => ({ ok: false, status: 404, error: 'Not found' })) as never,
      getApprovalForOrigin: (async () => ({ ok: true, id: 'apr_m2' })) as never,
    })
    const response = await GET(getJson('/api/v1/approvals/apr_m2', { authorization: `Bearer ${KEY}` }), params('apr_m2'))
    assert.equal(response.status, 429)
    expectLimited('read', hashApiKey(KEY))
  })

  it('POST /api/v1/approvals/[id]/cancel (requester key): counted after authentication', async () => {
    denySeam()
    const response = await cancelRoute.POST(postJson('/api/v1/approvals/apr_m2/cancel', { reason: 'x' }, { authorization: `Bearer ${KEY}` }), params('apr_m2'))
    assert.equal(response.status, 429)
    expectLimited('write', hashApiKey(KEY))
  })

  it('POST /api/v1/housekeeping: counted per hashed cron token after authorization', async () => {
    denySeam()
    const response = await housekeepingRoute.POST(postJson('/api/v1/housekeeping', {}, { authorization: 'Bearer m2-cron-secret' }))
    assert.equal(response.status, 429)
    assert.match(seamCalls[0]!.kind, /^write$/)
    assert.equal(fakes.workCalls.length, 0)
  })

  it('POST /api/v1/invites/lookup: counted per hashed token after verification', async () => {
    denySeam()
    const response = await inviteHandlers.handleInviteLookup(
      postJson('/api/v1/invites/lookup', { token: VALID_INVITE }),
      { getSessionUser: async () => null, findUserIdByEmail: async () => null, signUp: async () => ({ userId: 'u', setCookies: [] }) },
    )
    assert.equal(response.status, 429)
    assert.equal(seamCalls[0]!.kind, 'invite')
    assert.equal(fakes.workCalls.includes('lookupInvite'), true, 'the token was verified before counting')
    // exactly one limiter call: the verified budget, not failed-auth
    assert.equal(seamCalls.length, 1)
  })

  it('POST /api/v1/invites/accept: counted per hashed token before any acceptance work', async () => {
    denySeam()
    const response = await inviteHandlers.handleInviteAccept(
      postJson('/api/v1/invites/accept', { token: VALID_INVITE, name: 'N', password: 'a-long-enough-password' }),
      { getSessionUser: async () => null, findUserIdByEmail: async () => null, signUp: async () => ({ userId: 'u', setCookies: [] }) },
    )
    assert.equal(response.status, 429)
    assert.equal(seamCalls[0]!.kind, 'invite')
    assert.equal(fakes.workCalls.includes('lookupInvite'), true)
    assert.equal(fakes.workCalls.includes('acceptInviteWithNewAccount'), false, 'the budget gates before account work')
  })

  it('GET /api/v1/signup-status: counted per client address', async () => {
    denySeam()
    const response = await signupStatusRoute.GET(getJson('/api/v1/signup-status', { 'x-forwarded-for': '198.18.7.7' }))
    assert.equal(response.status, 429)
    assert.equal(seamCalls[0]!.kind, 'read')
    assert.match(seamCalls[0]!.subject, /^addr:/)
  })

  it('GET /api/v1/health is exempt: it answers even when every family would deny (S1)', async () => {
    denySeam()
    const healthRoute = await import('../app/api/v1/health/route')
    const response = await healthRoute.GET()
    assert.equal(response.status, 200)
    assert.equal(seamCalls.length, 0, 'health must not consult the limiter at all')
  })

  it('a request through nested guards is billed exactly once (S3)', async () => {
    seamCalls = []
    setRestLimitAcquireOverrideForTests((kind, subject) => {
      seamCalls.push({ kind, subject })
      return { allowed: true, retryAfterMs: 0, count: seamCalls.length }
    })
    await sessionGuard.withApiTenant(async () => {
      // a route body that runs a second guard pass, like requireApiProject does
      const inner = await sessionGuard.requireApiSession()
      assert.equal(inner.ok, true)
      return null
    })
    assert.equal(seamCalls.length, 1, 'nested withApiTenant must not double-count the request')
  })

  it('failed-auth attempts are refused per address with Retry-After (M5)', async () => {
    denySeam()
    fakes.authn = null
    const response = await approvalsRoute.GET(getJson('/api/v1/approvals', { authorization: `Bearer ${KEY}`, 'x-forwarded-for': '198.18.7.8' }))
    assert.equal(response.status, 429)
    assert.equal(seamCalls[0]!.kind, 'failed-auth')
    assert.match(seamCalls[0]!.subject, /^addr:/)
  })
})

// ---- wiring scans (unhooking the wiring fails these) ----

describe('limiter wiring scans (M2)', () => {
  it('Better Auth is wired to the shared customStorage and the auth route mirrors Retry-After', async () => {
    const fs = await import('node:fs')
    const authSrc = fs.readFileSync(new URL('./auth.ts', import.meta.url), 'utf8')
    assert.match(authSrc, /rateLimit\s*:\s*\{[\s\S]*customStorage/, 'auth.ts must wire rateLimit.customStorage')
    const routeSrc = fs.readFileSync(new URL('../app/api/auth/[...all]/route.ts', import.meta.url), 'utf8')
    assert.match(routeSrc, /x-retry-after/i, 'the auth catch-all must read the mirrored header')
    assert.match(routeSrc, /['"]retry-after['"]/i, 'the auth catch-all must emit Retry-After')
  })
})
