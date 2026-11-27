/**
 * Contract test for the verify-token boundary between the HITLy MCP edge and
 * the host (finding B1): the REAL MCP client (`verifyDelegatedToken` from
 * apps/mcp/src/oauth.ts) is driven against the REAL route factory
 * (`handleMcpVerifyTokenFactory`) with no verifyToken stub anywhere. Only the
 * final signature/revocation check (the cloud handler) is injected.
 *
 * Proves: token travels in the Authorization header only (no body), caller
 * auth + per-caller (never per-token) budgeting work end to end, acceptance
 * is exactly 200 + {ok:true}, and the 429 Retry-After survives the round
 * trip.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  VERIFY_TOKEN_PATH,
  VERIFY_TOKEN_SECRET_HEADER,
  extractBearer,
  verifyDelegatedToken,
  DELEGATED_TOKEN_MAX_LENGTH as MCP_TOKEN_MAX_LENGTH,
} from '../../mcp/src/oauth.ts'
import type { McpConfig } from '../../mcp/src/config.ts'
import { isWellFormedDelegatedToken, DELEGATED_TOKEN_MAX_LENGTH as APP_TOKEN_MAX_LENGTH } from './keys'
import { handleMcpVerifyTokenFactory } from './mcp-verify-token-route'
import type { RateLimitDecision } from './rate-limit'

const SECRET = 'edge-shared-secret-1'
const VALID_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvcGVyYXRvciJ9.' + 's'.repeat(43)
const ALLOW = new Set([VALID_TOKEN])

function mcpConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    port: 3006,
    listenHost: '127.0.0.1',
    apiUrl: 'https://host.hitly.test',
    mcpPath: '/mcp',
    maxBodyBytes: 1_000_000,
    rateLimit: 120,
    rateWindowMs: 60_000,
    hostCapabilities: [],
    ...overrides,
  } as McpConfig
}

interface RouteHarness {
  handler: (request: Request) => Promise<Response>
  /** The fetch the MCP client would use, wired straight into the route. */
  clientFetch: (url: string, init: RequestInit) => Promise<Response>
  delegateCalls: { authorization: string | null; secret: string | null; body: string | null; url: string }[]
  limiterCalls: { kind: string; subject: string }[]
}

function harness(opts: {
  callerSecret?: string
  verify?: (token: string) => Promise<boolean>
  denyAfter?: number
} = {}): RouteHarness {
  const h: RouteHarness = {
    handler: async () => new Response(null, { status: 500 }),
    clientFetch: async (url, init) => h.handler(new Request(url, init)),
    delegateCalls: [],
    limiterCalls: [],
  }
  const delegate = async (request: Request): Promise<Response> => {
    h.delegateCalls.push({
      authorization: request.headers.get('authorization'),
      secret: request.headers.get(VERIFY_TOKEN_SECRET_HEADER),
      body: request.body ? await request.text() : null,
      url: new URL(request.url).pathname,
    })
    const auth = request.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const ok = await (opts.verify ?? (async (t) => ALLOW.has(t)))(token)
    return ok
      ? new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('{"error":"invalid_token"}', { status: 401, headers: { 'content-type': 'application/json' } })
  }
  let acquisitions = 0
  const acquire = async (subject: string): Promise<RateLimitDecision> => {
    h.limiterCalls.push({ kind: 'mcp-verify', subject })
    acquisitions += 1
    return opts.denyAfter !== undefined && acquisitions > opts.denyAfter
      ? { allowed: false, retryAfterMs: 30_000, count: acquisitions }
      : { allowed: true, retryAfterMs: 0, count: acquisitions }
  }
  const failedAcquire = async (subject: string): Promise<RateLimitDecision> => {
    h.limiterCalls.push({ kind: 'failed-auth', subject })
    return { allowed: true, retryAfterMs: 0, count: 1 }
  }
  h.handler = handleMcpVerifyTokenFactory({
    callerSecret: 'callerSecret' in opts ? opts.callerSecret : SECRET,
    delegate,
    acquire,
    failedAcquire,
  })
  return h
}

const verifyClient = (h: RouteHarness, token = VALID_TOKEN, config = mcpConfig({ verifyTokenSecret: SECRET })) =>
  verifyDelegatedToken(config, token, h.clientFetch)

describe('verify-token contract (real MCP client ⇄ real route factory)', () => {
  it('shares the header name and path constants with the MCP edge', () => {
    // The route module imports these same constants from oauth.ts — drift is
    // impossible, but pin the values so a rename on one side breaks loudly.
    assert.equal(VERIFY_TOKEN_PATH, '/api/v1/mcp/verify-token')
    assert.equal(VERIFY_TOKEN_SECRET_HEADER, 'x-hitly-mcp-secret')
    assert.ok(isWellFormedDelegatedToken(VALID_TOKEN))
    // Session bearers (40 base64url chars, no dots) are gated identically.
    assert.equal(isWellFormedDelegatedToken('K'.repeat(40)), false)
  })

  it('happy path: token in the Authorization header only, no body, exact 200 {ok:true}', async () => {
    const h = harness()
    const result = await verifyClient(h)
    assert.deepEqual(result, { ok: true })
    assert.equal(h.delegateCalls.length, 1)
    const call = h.delegateCalls[0]!
    assert.equal(call.authorization, `Bearer ${VALID_TOKEN}`)
    assert.equal(call.secret, SECRET)
    assert.equal(call.body, null, 'the contract is header-only: no request body')
    assert.equal(call.url, VERIFY_TOKEN_PATH)
  })

  it('fails closed with 503 when the host has no caller secret configured', async () => {
    const h = harness({ callerSecret: undefined })
    const result = await verifyClient(h)
    assert.equal(result.ok, false)
    assert.equal(result.status, 503)
    assert.equal(h.delegateCalls.length, 0, 'verification must not run when unconfigured')
  })

  it('rejects a missing or wrong caller secret, counting per client address in failed-auth', async () => {
    for (const secret of [undefined, 'wrong-secret']) {
      const h = harness()
      const config = mcpConfig({ verifyTokenSecret: secret })
      const result = await verifyDelegatedToken(config, VALID_TOKEN, h.clientFetch)
      assert.equal(result.ok, false)
      assert.equal(result.status, 401)
      assert.equal(h.delegateCalls.length, 0)
      const failed = h.limiterCalls.filter((c) => c.kind === 'failed-auth')
      assert.equal(failed.length, 1, 'bad-caller attempt counts once in failed-auth')
      assert.ok(failed[0]!.subject.startsWith('addr:'), 'failed-auth keys on the client address')
    }
  })

  it('refuses malformed bearers locally without consulting the verifier', async () => {
    const h = harness()
    for (const junk of ['K'.repeat(40), 'not-even-jwt', 'hitly_short_guess', 'a.b', `${VALID_TOKEN}.`]) {
      const res = await h.handler(
        new Request('https://host.hitly.test' + VERIFY_TOKEN_PATH, {
          method: 'POST',
          headers: { authorization: junk.startsWith('Bearer ') ? junk : `Bearer ${junk}`, [VERIFY_TOKEN_SECRET_HEADER]: SECRET },
        }),
      )
      assert.equal(res.status, 401, `expected refusal for ${junk}`)
      assert.deepEqual(await res.json(), { error: 'invalid_token' })
    }
    assert.equal(h.delegateCalls.length, 0)
  })

  it('budgets per caller, not per presented token: rotating tokens still exhausts one bucket', async () => {
    const h = harness({ denyAfter: 3, verify: async () => true })
    const tokens = ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20), 'd'.repeat(20)].map(
      (s) => `${s}.${'p'.repeat(20)}.${'q'.repeat(20)}`,
    )
    const results = []
    for (const token of tokens) results.push(await verifyClient(h, token))
    assert.deepEqual(results.slice(0, 3).map((r) => r.ok), [true, true, true])
    assert.equal(results[3]!.ok, false)
    assert.equal(results[3]!.status, 429, 'the 429 keeps its status')
    assert.equal(results[3]!.retryAfterMs, 30_000, 'Retry-After survives the round trip')
    // One bucket for all four tokens: same subject, because the subject keys
    // on the caller address, not the presented credentials.
    const subjects = new Set(h.limiterCalls.map((c) => c.subject))
    assert.equal(subjects.size, 1)
    assert.ok(![...subjects][0]!.includes(VALID_TOKEN), 'the limiter never sees the raw token')
  })

  it('revoked or expired tokens (verifier says no) come back 401 invalid_token', async () => {
    const h = harness({ verify: async () => false })
    const result = await verifyClient(h)
    assert.deepEqual(result, { ok: false, status: 401 })
  })

  it('a bare 200 from anything standing in front of the host is not acceptance', async () => {
    const h = harness({ verify: async () => true })
    const hollow = await verifyDelegatedToken(mcpConfig({ verifyTokenSecret: SECRET }), VALID_TOKEN, async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    assert.deepEqual(hollow, { ok: false, status: 401 })
    void h
  })

  it('the MCP server classifies the token the same way the route gates it', () => {
    // Whatever the route accepts as a bearer, extractBearer must classify as
    // a delegated token — otherwise verified-and-forwarded credentials could
    // be rejected upstream (or vice versa).
    assert.deepEqual(extractBearer(`Bearer ${VALID_TOKEN}`), { kind: 'token', token: VALID_TOKEN })
    assert.deepEqual(extractBearer(`Bearer ${'K'.repeat(40)}`), { error: 'invalid' })
  })
})

describe('shared token-size cap (review B4)', () => {
  it('both sides share one cap and accept realistically sized production JWTs', () => {
    assert.equal(MCP_TOKEN_MAX_LENGTH, APP_TOKEN_MAX_LENGTH)
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
      iss: 'https://cloud.hitly.net',
      sub: '0f1e2d3c-4b5a-4978-8675-6453f2e1d0c9',
      aud: 'https://mcp.hitly.net',
      exp: 1_800_000_000,
      iat: 1_799_996_400,
      jti: '9a8b7c6d-5e4f-4a1b-9c8d-7e6f5a4b3c2d',
      workspace_id: '3f2e1d0c-9b8a-4765-9483-7261504f3e2d',
      project_id: '7a6b5c4d-3e2f-4109-8765-4321fedcba09',
      key_id: 'key_mcp_0123456789abcdef0123456789abcdef',
      client_id: 'grok-bot',
      scope: 'hitly.mcp',
    })}.sig_1234567890abcdefghijklmnopqrstuvwxyzABCDEFG`
    // Production tokens measure ~580–600 chars; both gates must accept them.
    assert.ok(token.length >= 550 && token.length <= APP_TOKEN_MAX_LENGTH, `unexpected length ${token.length}`)
    assert.deepEqual(extractBearer(`Bearer ${token}`), { kind: 'token', token })
    assert.equal(isWellFormedDelegatedToken(token), true)
  })
})
