/**
 * Route policy tests for GET /api/v1/approvals/:id/original-request (hitly#98).
 * Pins session auth, API-key refusal, no-workspace 404, Cache-Control: no-store,
 * and that captured logs never contain the payload (kills M5/M9/M12-class mutants).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NextResponse } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOriginalRequestGet } from './original-request-route'
import type { ApiTenantOk } from './api-session'
import type { OriginalRequestOk } from './original-request'

const PAYLOAD = '{"secret":"sk_live_SHOULD_NOT_APPEAR_IN_LOGS","z":1,"a":2}'

const okResult: OriginalRequestOk = {
  ok: true,
  requestId: 'apr_test',
  canonicalPayload: PAYLOAD,
  payloadSha256: 'abc123',
  argsSha256: 'def456',
  payloadHash: 'ghi789',
  argsHash: 'jkl012',
}

function ctx(): ApiTenantOk {
  return {
    ok: true,
    session: { user: { id: 'usr_1', name: 'R', email: 'r@example.com' } },
    workspaces: [{ id: 'wsp_1', name: 'W', slug: 'w', role: 'member' }],
    workspace: { id: 'wsp_1', name: 'W', slug: 'w', role: 'member' },
    role: 'member',
  } as ApiTenantOk
}

function params(id = 'apr_test') {
  return { params: Promise.resolve({ id }) }
}

describe('original-request route', () => {
  it('wires withApiTenant in the Next route module (session guard must stay)', () => {
    const routePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../app/api/v1/approvals/[id]/original-request/route.ts',
    )
    const source = fs.readFileSync(routePath, 'utf8')
    assert.match(source, /withApiTenant/, 'route must use withApiTenant')
    assert.match(source, /createOriginalRequestGet/, 'route must use the factory')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(
      code,
      /authorization|Bearer|apiKey|getApprovalForOrigin/i,
      'route executable code must not grow an API-key success path',
    )
  })

  it('returns 401 when there is no session', async () => {
    const GET = createOriginalRequestGet({
      withApiTenant: async () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      getOriginalRequest: async () => {
        throw new Error('loader must not run without a session')
      },
    })
    const response = await GET(new Request('http://localhost/api/v1/approvals/apr_test/original-request'), params())
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Unauthorized' })
  })

  it('refuses a project API key used as bearer (no session → 401; no API-key path)', async () => {
    // withApiTenant only understands Better Auth sessions. A bare project API key
    // never establishes a session here, so the route refuses with 401 — it must
    // not fall through to a reduced origin view the way GET /approvals/:id does.
    let loaderCalled = false
    const GET = createOriginalRequestGet({
      withApiTenant: async () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      getOriginalRequest: async () => {
        loaderCalled = true
        return okResult
      },
    })
    const request = new Request('http://localhost/api/v1/approvals/apr_test/original-request', {
      headers: { authorization: 'Bearer hk_live_project_key_for_origin' },
    })
    const response = await GET(request, params())
    assert.equal(response.status, 401)
    assert.equal(loaderCalled, false, 'API key must not reach the loader')
  })

  it('returns 404 when the session has no workspace', async () => {
    const GET = createOriginalRequestGet({
      withApiTenant: async () => NextResponse.json({ error: 'Not found' }, { status: 404 }),
      getOriginalRequest: async () => {
        throw new Error('loader must not run without a workspace')
      },
    })
    const response = await GET(new Request('http://localhost/api/v1/approvals/apr_test/original-request'), params())
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Not found' })
  })

  it('sets Cache-Control: no-store on success and never logs the payload', async () => {
    const lines: string[] = []
    const GET = createOriginalRequestGet({
      withApiTenant: async (fn) => fn(ctx()),
      getOriginalRequest: async () => okResult,
      logInfo: (...args: unknown[]) => {
        lines.push(args.map(String).join(' '))
      },
    })
    const response = await GET(new Request('http://localhost/api/v1/approvals/apr_test/original-request'), params())
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    const body = (await response.json()) as OriginalRequestOk
    assert.equal(body.canonicalPayload, PAYLOAD)

    assert.ok(lines.length >= 1, 'success must log a summary')
    const joined = lines.join('\n')
    assert.ok(!joined.includes('sk_live_SHOULD_NOT_APPEAR_IN_LOGS'), 'payload must never appear in logs')
    assert.ok(!joined.includes(PAYLOAD), 'canonical payload must never appear in logs')
    assert.ok(joined.includes('apr_test'))
    assert.ok(joined.includes('abc123'))
  })
})
