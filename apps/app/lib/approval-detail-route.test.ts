/**
 * Route policy tests for GET /api/v1/approvals/:id session/mobile path (#119 soft 2).
 * Pins requireApiWorkspace: unauthenticated and no-workspace requests must be
 * rejected by that helper, and the Next route module must keep wiring it.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NextResponse } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApprovalDetailGet } from './approval-detail-route'
import type { ApiWorkspaceOk } from './api-session'

function params(id = 'apr_test') {
  return { params: Promise.resolve({ id }) }
}

function workspaceCtx(workspaceId = 'wsp_1'): ApiWorkspaceOk {
  return {
    ok: true,
    session: { user: { id: 'usr_1', name: 'R', email: 'r@example.com' } },
    workspaces: [{ id: workspaceId, name: 'W', slug: 'w', role: 'member' }],
    workspace: { id: workspaceId, name: 'W', slug: 'w', role: 'member' },
    role: 'member',
  } as ApiWorkspaceOk
}

describe('approval detail route (session / mobile)', () => {
  it('wires requireApiWorkspace in the Next route module (session guard must stay)', () => {
    const routePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../app/api/v1/approvals/[id]/route.ts',
    )
    const source = fs.readFileSync(routePath, 'utf8')
    assert.match(source, /requireApiWorkspace/, 'route must import requireApiWorkspace')
    assert.match(source, /createApprovalDetailGet/, 'route must use the factory')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.match(
      code,
      /createApprovalDetailGet\(\{[\s\S]*requireApiWorkspace[\s\S]*\}\)/,
      'factory must be called with requireApiWorkspace',
    )
  })

  it('returns 401 when requireApiWorkspace rejects an unauthenticated request', async () => {
    let detailCalled = false
    const GET = createApprovalDetailGet({
      requireApiWorkspace: async () => ({
        ok: false,
        error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      }),
      getApprovalDetail: async () => {
        detailCalled = true
        throw new Error('getApprovalDetail must not run without requireApiWorkspace')
      },
      getApprovalForOrigin: async () => {
        throw new Error('getApprovalForOrigin must not run without a bearer token')
      },
    })
    const response = await GET(new Request('http://localhost/api/v1/approvals/apr_test'), params())
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Unauthorized' })
    assert.equal(detailCalled, false, 'unauthenticated requests must not reach getApprovalDetail')
  })

  it('returns 404 when requireApiWorkspace yields no workspace', async () => {
    let detailCalled = false
    const GET = createApprovalDetailGet({
      requireApiWorkspace: async () =>
        ({
          ok: true,
          session: { user: { id: 'usr_1', name: 'R', email: 'r@example.com' } },
          workspaces: [],
          workspace: null,
          role: null,
        }) as ApiWorkspaceOk,
      getApprovalDetail: async () => {
        detailCalled = true
        throw new Error('getApprovalDetail must not run without a workspace')
      },
      getApprovalForOrigin: async () => {
        throw new Error('getApprovalForOrigin must not run without a bearer token')
      },
    })
    const response = await GET(new Request('http://localhost/api/v1/approvals/apr_test'), params())
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Not found' })
    assert.equal(detailCalled, false)
  })

  it('passes the workspace from requireApiWorkspace into getApprovalDetail (wrong workspace must not be skipped)', async () => {
    let seenWorkspaceId: string | undefined
    const GET = createApprovalDetailGet({
      requireApiWorkspace: async () => workspaceCtx('wsp_other'),
      getApprovalDetail: async (args) => {
        seenWorkspaceId = args.workspaceId
        return { ok: false as const, error: 'Not found', status: 404 as const }
      },
      getApprovalForOrigin: async () => {
        throw new Error('getApprovalForOrigin must not run without a bearer token')
      },
    })
    const response = await GET(new Request('http://localhost/api/v1/approvals/apr_test'), params())
    assert.equal(response.status, 404)
    assert.equal(seenWorkspaceId, 'wsp_other', 'detail loader must receive the helper-selected workspace')
  })

  it('falls through origin 401 to requireApiWorkspace (mobile session bearer)', async () => {
    let workspaceCalled = false
    let detailCalled = false
    const GET = createApprovalDetailGet({
      getApprovalForOrigin: async () => ({ ok: false as const, error: 'Unauthorized', status: 401 as const }),
      requireApiWorkspace: async () => {
        workspaceCalled = true
        return {
          ok: false,
          error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
        }
      },
      getApprovalDetail: async () => {
        detailCalled = true
        throw new Error('getApprovalDetail must not run when requireApiWorkspace rejects')
      },
    })
    const response = await GET(
      new Request('http://localhost/api/v1/approvals/apr_test', {
        headers: { authorization: 'Bearer session-not-a-project-key' },
      }),
      params(),
    )
    assert.equal(workspaceCalled, true, 'mobile 401 fallthrough must call requireApiWorkspace')
    assert.equal(detailCalled, false)
    assert.equal(response.status, 401)
  })
})
