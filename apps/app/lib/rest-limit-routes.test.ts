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
// Shape of a delegated OAuth access token (compact HS256 JWT) as issued by
// the Cloud auth server; whether it VERIFIES is steered via fakes.authn.
const DELEGATED_CANDIDATE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvcGVyYXRvcl9tMiJ9.0123456789abcdefghijklmnopqrstuvwxyzABCDE'
const VALID_INVITE = 'valid_invite_token_for_tests'
const VALID_INVITE2 = 'valid_invite_token_for_tests_two'
const VALID_INVITES = new Set([VALID_INVITE, VALID_INVITE2])

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
    isWellFormedInviteToken: (token: unknown) => fakes.inviteValid && typeof token === 'string' && VALID_INVITES.has(token),
    lookupInvite: async (token: unknown) => {
      fakes.workCalls.push('lookupInvite')
      return fakes.lookupOk && typeof token === 'string' && VALID_INVITES.has(token)
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

// ---- round-2: per-route failed-auth branches, isolation, MUST-1 ----

const KEY_A_ADDR = '198.18.7.41'
const KEY_B_ADDR = '198.18.7.42'

function allowUntil(max: number): () => Array<{ kind: RestLimitKind; subject: string }> {
  const counts = new Map<string, number>()
  seamCalls = []
  setRestLimitAcquireOverrideForTests((kind, subject) => {
    seamCalls.push({ kind, subject })
    const id = kind + '|' + subject
    const next = (counts.get(id) ?? 0) + 1
    counts.set(id, next)
    return next <= max
      ? { allowed: true, retryAfterMs: 0, count: next }
      : { allowed: false, retryAfterMs: 7_000, count: next }
  })
  return () => seamCalls
}

function detailGet(overrides: Partial<Parameters<typeof approvalDetailFactory.createApprovalDetailGet>[0]>) {
  return approvalDetailFactory.createApprovalDetailGet({
    requireApiWorkspace: async () => ({ ok: false as const, error: new Response(null, { status: 401 }) }) as never,
    getApprovalDetail: (async () => ({ ok: false, status: 404, error: 'Not found' })) as never,
    getApprovalForOrigin: (async () => {
      fakes.workCalls.push('getApprovalForOrigin')
      return { ok: true, id: 'apr_m2' }
    }) as never,
    authenticate: async (apiKey: string) => (apiKey === KEY ? fakes.authn : null),
    ...overrides,
  })
}

describe('per-route failed-auth branches (M2 round 2)', () => {
  it('GET by-run-id: a malformed key counts per address only, never per key (F1b/F4d)', async () => {
    denySeam()
    fakes.authn = null
    const response = await byRunIdRoute.GET(
      getJson('/api/v1/approvals/by-run-id?runId=run_m2', { authorization: 'Bearer hitly_t00short', 'x-forwarded-for': KEY_A_ADDR }),
    )
    assert.equal(response.status, 429)
    expectLimited('failed-auth')
    assert.match(seamCalls[0]!.subject, /^addr:/)
    assert.equal(seamCalls.some((c) => c.kind === 'read'), false, 'a malformed key must never reach the per-key budget')
  })

  it('GET by-run-id: a well-formed unknown key counts per address, no per-key call before auth (F3c/F4e)', async () => {
    denySeam()
    fakes.authn = null
    const response = await byRunIdRoute.GET(
      getJson('/api/v1/approvals/by-run-id?runId=run_m2', { authorization: `Bearer ${KEY}`, 'x-forwarded-for': KEY_A_ADDR }),
    )
    assert.equal(response.status, 429)
    expectLimited('failed-auth')
    assert.match(seamCalls[0]!.subject, /^addr:/)
    assert.equal(seamCalls.some((c) => c.kind === 'read'), false, 'an unauthenticated key must never reach the per-key budget')
  })

  it('POST cancel: a well-formed unknown key counts per address, no per-key write call (F3d/F4f)', async () => {
    denySeam()
    fakes.authn = null
    // No session: without this the request would fall through to a logged-in
    // reviewer path whose own read budget could answer the 429 instead.
    fakes.sessionUser = null
    const response = await cancelRoute.POST(
      postJson('/api/v1/approvals/apr_m2/cancel', { reason: 'x' }, { authorization: `Bearer ${KEY}`, 'x-forwarded-for': KEY_A_ADDR }),
      params('apr_m2'),
    )
    assert.equal(response.status, 429)
    assert.equal(seamCalls.length, 1, 'exactly one limiter call — the failed-auth one')
    assert.equal(seamCalls[0]!.kind, 'failed-auth')
    assert.match(seamCalls[0]!.subject, /^addr:/)
    fakes.sessionUser = { id: 'usr_m2', name: 'M2', email: 'm2@example.com' }
    fakes.authn = { project: { id: 'prj_m2', workspaceId: 'ws_m2' } }
  })

  it('POST cancel: a bearer that fails the session check counts per address (F4m)', async () => {
    denySeam()
    fakes.sessionUser = null
    const response = await cancelRoute.POST(
      postJson('/api/v1/approvals/apr_m2/cancel', {}, { authorization: 'Bearer session-looking-bearer', 'x-forwarded-for': KEY_A_ADDR }),
      params('apr_m2'),
    )
    assert.equal(response.status, 429)
    assert.equal(seamCalls.length, 1, 'exactly one limiter call — the failed-auth one')
    assert.equal(seamCalls[0]!.kind, 'failed-auth')
    assert.match(seamCalls[0]!.subject, /^addr:/)
    fakes.sessionUser = { id: 'usr_m2', name: 'M2', email: 'm2@example.com' }
  })

  it('POST cancel: a valid bearer session is never counted in failed-auth (MUST-A)', async () => {
    // Mobile reviewers send `Authorization: Bearer <session token>`; 20 of
    // them from one address must never mint a failed-auth call nor a 429.
    fakes.sessionUser = { id: 'usr_m2', name: 'M2', email: 'm2@example.com' }
    allowUntil(30)
    for (let i = 0; i < 20; i++) {
      const response = await cancelRoute.POST(
        postJson('/api/v1/approvals/apr_m2/cancel', {}, { authorization: 'Bearer valid-session-token', 'x-forwarded-for': KEY_A_ADDR }),
        params('apr_m2'),
      )
      assert.notEqual(response.status, 429, `request ${String(i)} must never be rate limited`)
    }
    assert.equal(seamCalls.some((c) => c.kind === 'failed-auth'), false, 'a valid session must never touch failed-auth')
  })

  it('POST cancel: a delegated token that fails verification counts per address, never per subject (F4n)', async () => {
    // A JWT-shaped bearer is a delegated-token CANDIDATE: it enters the
    // key path, but when verification fails it is a failed login — counted
    // once in the per-client failed-auth budget, never in the per-subject
    // write budget (and a second pass through the route, which falls
    // through to the session check, must not count it again).
    denySeam()
    fakes.authn = null
    fakes.sessionUser = null
    const response = await cancelRoute.POST(
      postJson('/api/v1/approvals/apr_m2/cancel', {}, { authorization: `Bearer ${DELEGATED_CANDIDATE}`, 'x-forwarded-for': KEY_A_ADDR }),
      params('apr_m2'),
    )
    assert.equal(response.status, 429)
    assert.equal(seamCalls.length, 1, 'exactly one limiter call — the failed-auth one')
    assert.equal(seamCalls[0]!.kind, 'failed-auth')
    assert.match(seamCalls[0]!.subject, /^addr:/)
    fakes.sessionUser = { id: 'usr_m2', name: 'M2', email: 'm2@example.com' }
    fakes.authn = { project: { id: 'prj_m2', workspaceId: 'ws_m2' } }
  })

  it('POST cancel: a verified delegated token counts per subject in the write budget (F4o)', async () => {
    // Grok's MCP server cancels with its delegated OAuth access token.
    // Authenticated, it is a subject like any API key: counted per token
    // hash in the write budget, never in failed-auth.
    denySeam()
    fakes.sessionUser = null
    const response = await cancelRoute.POST(
      postJson('/api/v1/approvals/apr_m2/cancel', { reason: 'x' }, { authorization: `Bearer ${DELEGATED_CANDIDATE}`, 'x-forwarded-for': KEY_A_ADDR }),
      params('apr_m2'),
    )
    assert.equal(response.status, 429)
    expectLimited('write', hashApiKey(DELEGATED_CANDIDATE))
    assert.equal(seamCalls.some((c) => c.kind === 'failed-auth'), false, 'an authenticated token must never touch failed-auth')
    fakes.sessionUser = { id: 'usr_m2', name: 'M2', email: 'm2@example.com' }
  })

  it('GET [id]: a well-formed unknown key counts per address, never per key (M4a/F4g)', async () => {
    denySeam()
    const GET = detailGet({ authenticate: async () => null })
    const response = await GET(
      getJson('/api/v1/approvals/apr_m2', { authorization: `Bearer ${KEY}`, 'x-forwarded-for': KEY_A_ADDR }),
      params('apr_m2'),
    )
    assert.equal(response.status, 429)
    expectLimited('failed-auth')
    assert.match(seamCalls[0]!.subject, /^addr:/)
    assert.equal(seamCalls.some((c) => c.kind === 'read'), false, 'an unauthenticated key must never reach the per-key budget')
  })

  it('GET [id]: a bearer that fails the session check counts per address (F4l)', async () => {
    denySeam()
    const GET = detailGet({})
    const response = await GET(
      getJson('/api/v1/approvals/apr_other', { authorization: 'Bearer session-looking-bearer', 'x-forwarded-for': KEY_A_ADDR }),
      params('apr_other'),
    )
    assert.equal(response.status, 429)
    assert.equal(seamCalls.length, 1, 'exactly one limiter call — the failed-auth one')
    assert.equal(seamCalls[0]!.kind, 'failed-auth')
    assert.match(seamCalls[0]!.subject, /^addr:/)
  })

  it('GET [id]: a valid bearer session is never counted in failed-auth (MUST-A)', async () => {
    // Mobile reviewers call this endpoint with `Authorization: Bearer
    // <session token>`; 20 such requests from one address must all succeed
    // and must never mint a failed-auth limiter call.
    allowUntil(30)
    const GET = detailGet({
      requireApiWorkspace: async () =>
        ({
          ok: true,
          session: { user: { id: 'usr_m2', name: 'M2', email: 'm2@example.com' } },
          workspace: { id: 'ws_m2' },
          role: 'admin',
        }) as never,
      getApprovalDetail: (async () => ({ ok: true, id: 'apr_m2', status: 'pending' })) as never,
    })
    for (let i = 0; i < 20; i++) {
      const response = await GET(
        getJson('/api/v1/approvals/apr_m2', { authorization: 'Bearer valid-session-token', 'x-forwarded-for': KEY_A_ADDR }),
        params('apr_m2'),
      )
      assert.equal(response.status, 200, `request ${String(i)} must never be rate limited`)
    }
    assert.equal(seamCalls.length, 0, 'the session path must not consult the limiter at all here')
    assert.equal(seamCalls.some((c) => c.kind === 'failed-auth'), false)
  })

  it('GET [id]: a bearer whose session check answers 429/503 is NOT a failed login (MUST-C1)', async () => {
    // requireApiSession returns !ok with 429 when a VALID session hits its
    // own read budget (api-session.ts), and 503 when auth is not configured.
    // Neither is a failed login: the address's failed-auth budget must stay
    // untouched (cancel/route.ts already gates on === 401; [id] must too).
    // Allow-mode so a stray count would be recorded, not short-circuited.
    for (const status of [429, 503]) {
      allowUntil(30)
      const GET = detailGet({
        requireApiWorkspace: async () => ({ ok: false as const, error: new Response(null, { status }) }) as never,
      })
      const response = await GET(
        getJson('/api/v1/approvals/apr_m2', { authorization: 'Bearer valid-session-token', 'x-forwarded-for': KEY_A_ADDR }),
        params('apr_m2'),
      )
      assert.equal(response.status, status, `the ${String(status)} from the session check must pass through unchanged`)
      assert.equal(seamCalls.length, 0, `a ${String(status)} session-check answer must not mint a failed-auth count`)
    }
  })

  it('POST cancel: well-formed unknown key with no session counts EXACTLY once (MA6/MA9)', async () => {
    // Allow-mode: a SECOND count after the session 401 (the MA6/MA9 mutants)
    // would be recorded instead of hidden behind an early 429.
    fakes.authn = null
    fakes.sessionUser = null
    allowUntil(100)
    const response = await cancelRoute.POST(
      postJson('/api/v1/approvals/apr_m2/cancel', { reason: 'x' }, { authorization: `Bearer ${KEY}`, 'x-forwarded-for': KEY_A_ADDR }),
      params('apr_m2'),
    )
    assert.equal(response.status, 401, 'the unknown key falls through to the session check, which 401s')
    const failed = seamCalls.filter((c) => c.kind === 'failed-auth')
    assert.equal(failed.length, 1, 'exactly one failed-auth count — the unverified key branch only, never a second after the session 401')
    assert.match(failed[0]!.subject, /^addr:/)
    assert.equal(seamCalls.some((c) => c.kind === 'write'), false, 'an unauthenticated key must never reach the per-key write budget')
    fakes.sessionUser = { id: 'usr_m2', name: 'M2', email: 'm2@example.com' }
    fakes.authn = { project: { id: 'prj_m2', workspaceId: 'ws_m2' } }
  })

  it('POST cancel: no Authorization header counts NOTHING (MA9)', async () => {
    // MA9 (drop the apiKey/malformedBearer guard before the session-401
    // count) would count this anonymous 401 as a failed login.
    fakes.sessionUser = null
    allowUntil(100)
    const response = await cancelRoute.POST(
      postJson('/api/v1/approvals/apr_m2/cancel', {}, { 'x-forwarded-for': KEY_A_ADDR }),
      params('apr_m2'),
    )
    assert.equal(response.status, 401, 'an anonymous cancel 401s via the session check')
    assert.equal(seamCalls.length, 0, 'an absent Authorization header is not a failed login')
    fakes.sessionUser = { id: 'usr_m2', name: 'M2', email: 'm2@example.com' }
  })

  it('GET [id]: well-formed unknown key with a session 401 counts EXACTLY once (MA7/MA8)', async () => {
    // MA7 (malformedBearer = !!apiKey) and MA8 (always count after !ctx.ok)
    // both double-count this request: once in the key branch, once again
    // after the session 401. Allow-mode makes the second count visible.
    allowUntil(100)
    const GET = detailGet({ authenticate: async () => null })
    const response = await GET(
      getJson('/api/v1/approvals/apr_m2', { authorization: `Bearer ${KEY}`, 'x-forwarded-for': KEY_A_ADDR }),
      params('apr_m2'),
    )
    assert.equal(response.status, 401, 'the unknown key falls through to the session check, which 401s')
    const failed = seamCalls.filter((c) => c.kind === 'failed-auth')
    assert.equal(failed.length, 1, 'exactly one failed-auth count — the unverified key branch only, never a second after the session 401')
    assert.match(failed[0]!.subject, /^addr:/)
    assert.equal(seamCalls.some((c) => c.kind === 'read'), false, 'an unauthenticated key must never reach the per-key budget')
  })

  it('GET [id]: no Authorization header with a session 401 counts NOTHING (MA8)', async () => {
    // MA8 (drop the apiKey/malformedBearer guard after !ctx.ok) would count
    // this cookie-less 401 — e.g. an expired-cookie user — as a failed login.
    allowUntil(100)
    const GET = detailGet({})
    const response = await GET(
      getJson('/api/v1/approvals/apr_m2', { 'x-forwarded-for': KEY_A_ADDR }),
      params('apr_m2'),
    )
    assert.equal(response.status, 401)
    assert.equal(seamCalls.length, 0, 'an absent Authorization header is not a failed login')
  })

  it('GET [id] (MUST-1): an authenticated key is counted per key even when the id is not its own; over budget it gets 429 and the read is skipped', async () => {
    fakes.authn = { project: { id: 'prj_m2', workspaceId: 'ws_m2' } }
    const calls = allowUntil(2)
    const GET = detailGet({
      getApprovalForOrigin: (async () => {
        fakes.workCalls.push('getApprovalForOrigin')
        return { ok: false, status: 404, error: 'Not found' }
      }) as never,
    })
    const first = await GET(getJson('/api/v1/approvals/apr_gone', { authorization: `Bearer ${KEY}` }), params('apr_gone'))
    assert.equal(first.status, 404)
    const second = await GET(getJson('/api/v1/approvals/apr_gone2', { authorization: `Bearer ${KEY}` }), params('apr_gone2'))
    assert.equal(second.status, 404)
    const third = await GET(getJson('/api/v1/approvals/apr_gone3', { authorization: `Bearer ${KEY}` }), params('apr_gone3'))
    assert.equal(third.status, 429, 'probing unknown ids burns the read budget')
    assert.equal(third.headers.get('retry-after'), '7')
    const seen = calls()
    assert.equal(seen.filter((c) => c.kind === 'read' && c.subject === hashApiKey(KEY)).length, 3)
    assert.equal(
      fakes.workCalls.filter((w) => w === 'getApprovalForOrigin').length,
      2,
      'the budget is applied BEFORE the read: the over-budget probe must not hit the lookup',
    )
    fakes.authn = { project: { id: 'prj_m2', workspaceId: 'ws_m2' } }
  })

  it('POST invites/lookup: a malformed token counts per address only (F4h)', async () => {
    denySeam()
    const response = await inviteHandlers.handleInviteLookup(
      postJson('/api/v1/invites/lookup', { token: 'junk-token' }, { 'x-forwarded-for': KEY_A_ADDR }),
      { getSessionUser: async () => null, findUserIdByEmail: async () => null, signUp: async () => ({ userId: 'u', setCookies: [] }) },
    )
    assert.equal(response.status, 429)
    expectLimited('failed-auth')
    assert.match(seamCalls[0]!.subject, /^addr:/)
    assert.equal(seamCalls.some((c) => c.kind === 'invite'), false, 'an unverified token must never mint an invite bucket')
  })

  it('POST invites/lookup: an unknown (well-formed) token counts per address, never per token (F2c/F4i)', async () => {
    denySeam()
    fakes.lookupOk = false
    const response = await inviteHandlers.handleInviteLookup(
      postJson('/api/v1/invites/lookup', { token: VALID_INVITE }, { 'x-forwarded-for': KEY_A_ADDR }),
      { getSessionUser: async () => null, findUserIdByEmail: async () => null, signUp: async () => ({ userId: 'u', setCookies: [] }) },
    )
    assert.equal(response.status, 429)
    assert.equal(seamCalls[0]!.kind, 'failed-auth', 'an unknown token counts in the failed-auth budget')
    assert.match(seamCalls[0]!.subject, /^addr:/)
    assert.equal(seamCalls.some((c) => c.kind === 'invite'), false, 'an unknown token must never mint a per-token invite bucket')
    fakes.lookupOk = true
  })

  it('POST invites/accept: an unknown token counts per address, never per token (F4j)', async () => {
    denySeam()
    fakes.lookupOk = false
    const response = await inviteHandlers.handleInviteAccept(
      postJson('/api/v1/invites/accept', { token: VALID_INVITE, name: 'N', password: 'a-long-enough-password' }, { 'x-forwarded-for': KEY_A_ADDR }),
      { getSessionUser: async () => null, findUserIdByEmail: async () => null, signUp: async () => ({ userId: 'u', setCookies: [] }) },
    )
    assert.equal(response.status, 429)
    assert.equal(seamCalls[0]!.kind, 'failed-auth', 'an unknown token counts in the failed-auth budget')
    assert.match(seamCalls[0]!.subject, /^addr:/)
    assert.equal(seamCalls.some((c) => c.kind === 'invite'), false)
    fakes.lookupOk = true
  })

  it('GET list: a malformed key counts per address only (F4k)', async () => {
    denySeam()
    const response = await approvalsRoute.GET(
      getJson('/api/v1/approvals', { authorization: 'Bearer totally-malformed', 'x-forwarded-for': KEY_A_ADDR }),
    )
    assert.equal(response.status, 429)
    expectLimited('failed-auth')
    assert.match(seamCalls[0]!.subject, /^addr:/)
    assert.equal(seamCalls.some((c) => c.kind === 'read'), false)
  })

  it('two addresses keep separate failed-auth budgets; a flood from one never locks out the other (F6a)', async () => {
    allowUntil(2)
    {
      const heads = (addr: string) => ({ authorization: 'Bearer malformed-key-x', 'x-forwarded-for': addr })
      assert.notEqual((await approvalsRoute.GET(getJson('/api/v1/approvals', heads(KEY_A_ADDR)))).status, 429)
      assert.notEqual((await approvalsRoute.GET(getJson('/api/v1/approvals', heads(KEY_A_ADDR)))).status, 429)
      assert.equal((await approvalsRoute.GET(getJson('/api/v1/approvals', heads(KEY_A_ADDR)))).status, 429, 'address A spent its budget')
      const b = await approvalsRoute.GET(getJson('/api/v1/approvals', heads(KEY_B_ADDR)))
      assert.notEqual(b.status, 429, 'address B must be unaffected by a flood from A')
      const subjects = new Set(seamCalls.filter((c) => c.kind === 'failed-auth').map((c) => c.subject))
      assert.equal(subjects.size, 2, 'the two addresses must use different subjects')
    }
  })

  it('two addresses keep separate client-address budgets on signup-status (S3)', async () => {
    allowUntil(2)
    {
      const heads = (addr: string) => ({ 'x-forwarded-for': addr })
      assert.notEqual((await signupStatusRoute.GET(getJson('/api/v1/signup-status', heads(KEY_A_ADDR)))).status, 429)
      assert.notEqual((await signupStatusRoute.GET(getJson('/api/v1/signup-status', heads(KEY_A_ADDR)))).status, 429)
      assert.equal((await signupStatusRoute.GET(getJson('/api/v1/signup-status', heads(KEY_A_ADDR)))).status, 429)
      const b = await signupStatusRoute.GET(getJson('/api/v1/signup-status', heads(KEY_B_ADDR)))
      assert.notEqual(b.status, 429, 'a flood from A must not throttle B')
      const subjects = new Set(seamCalls.filter((c) => c.kind === 'read').map((c) => c.subject))
      assert.equal(subjects.size, 2)
    }
  })

  it('two invite tokens keep separate budgets; exhausting one never blocks the other (S4)', async () => {
    allowUntil(2)
    const deps = { getSessionUser: async () => null, findUserIdByEmail: async () => null, signUp: async () => ({ userId: 'u', setCookies: [] }) }
    const call = (token: string) => inviteHandlers.handleInviteLookup(postJson('/api/v1/invites/lookup', { token }), deps)
    assert.notEqual((await call(VALID_INVITE)).status, 429)
    assert.notEqual((await call(VALID_INVITE)).status, 429)
    assert.equal((await call(VALID_INVITE)).status, 429, 'token A spent its budget')
    const b = await call(VALID_INVITE2)
    assert.notEqual(b.status, 429, 'token B must be unaffected by token A exhaustion')
    const inviteSubjects = new Set(seamCalls.filter((c) => c.kind === 'invite').map((c) => c.subject))
    assert.equal(inviteSubjects.size, 2, 'the invite budget must key on the token')
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

  it('Better Auth storage converts the rule window from seconds to ms (BA2)', async () => {
    const { createAuthRateLimitStorage } = await import('./rate-limit')
    const seen: Array<{ route: string; key: string; limit: number; windowMs: number }> = []
    const stub = () => ({
      async acquire(route: string, key: string, rule: { limit: number; windowMs: number }) {
        seen.push({ route, key, limit: rule.limit, windowMs: rule.windowMs })
        return { allowed: false, retryAfterMs: 7_000, count: 99 }
      },
      async sweepExpired() {
        return 0
      },
    }) as never
    const storage = createAuthRateLimitStorage(stub)
    const verdict = await storage.consume('key-1', { window: 60, max: 5 })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.route, 'auth')
    assert.equal(seen[0]!.limit, 5)
    assert.equal(seen[0]!.windowMs, 60_000, 'Better Auth rules carry SECONDS — the storage must multiply by 1000')
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.retryAfter, 7, 'retryAfter must be whole seconds')
  })

  it('mfa-verify counts through the shared family with the shipped 10/15min defaults (R12)', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('./mfa-limit.ts', import.meta.url), 'utf8')
    assert.match(
      src,
      /export const mfaVerifyAcquire = createRateAcquire\('mfa-verify',\s*\{\s*limit: MFA_VERIFY_ATTEMPT_LIMIT,\s*windowMs: MFA_VERIFY_ATTEMPT_WINDOW_MS,?\s*\}\)/,
      'mfa-verify wiring must pass the shipped constants (a hard-coded limit here disables the pin)',
    )
    const { MFA_VERIFY_ATTEMPT_LIMIT, MFA_VERIFY_ATTEMPT_WINDOW_MS } = await import('./mfa-limit')
    assert.equal(MFA_VERIFY_ATTEMPT_LIMIT, 10)
    assert.equal(MFA_VERIFY_ATTEMPT_WINDOW_MS, 15 * 60 * 1000)
  })

  it('the read family counts under the rest-read route, write under rest-write (R14)', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('./rest-limit.ts', import.meta.url), 'utf8')
    assert.match(src, /read:\s*createRateAcquire\('rest-read'/, 'read family must count under route rest-read')
    assert.match(src, /write:\s*createRateAcquire\('rest-write'/, 'write family must count under route rest-write')
    assert.match(src, /invite:\s*createRateAcquire\('invite'/, 'invite family must count under route invite')
    assert.match(src, /'failed-auth':\s*createRateAcquire\('failed-auth'/, 'failed-auth must count under route failed-auth')
  })

  it('the opportunistic sweep is wired into acquire, throttled by interval (SW3, core)', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../../../packages/db/src/rate-limit.ts', import.meta.url), 'utf8')
    assert.match(
      src,
      /if \(at - lastSweepAt >= sweepIntervalMs\)\s*\{\s*lastSweepAt = at\s*sweepExpired\(\)\.catch\(\(\) => undefined\)/,
      'acquire must trigger the expiry sweep (throttled per process)',
    )
  })
})
