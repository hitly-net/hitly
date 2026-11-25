import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NextResponse } from 'next/server'
import {
  handleMastraFactoryApprovalsList,
  handleMastraFactoryApprovalGet,
  type MastraFactoryApprovalsDeps,
  type MastraFactoryApprovalState,
} from './mastra-factory-approvals'

const KEY = 'hitly_' + 'a'.repeat(32)

function get(path: string, authorization: string | null): Request {
  return new Request(`http://localhost:3001/api/v1/projects/prj_x/integrations/mastra-factory/${path}`, {
    headers: authorization ? { authorization } : {},
  })
}

function deps(overrides: Partial<MastraFactoryApprovalsDeps> = {}): MastraFactoryApprovalsDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    authenticate: async () => {
      calls.push('authenticate')
      return { project: { plugin: 'mastra-factory', workspaceId: 'wsp_1' } }
    },
    applyRestReadLimit: async () => null,
    applyFailedAuth: async () => {
      calls.push('failedAuth')
      return null
    },
    listOpen: async () => {
      calls.push('listOpen')
      return { approvals: [] }
    },
    readState: async () => {
      calls.push('readState')
      return null
    },
    ...overrides,
  }
}

describe('GET /api/v1/projects/:id/integrations/mastra-factory/approvals', () => {
  it('missing API key answers 401 before anything is consulted', async () => {
    const d = deps()
    const response = await handleMastraFactoryApprovalsList(get('approvals', null), 'prj_x', d)
    assert.equal(response.status, 401)
    assert.deepEqual(d.calls, [])
  })

  it('malformed key answers 401 through the failed-auth limiter, never authenticated', async () => {
    const d = deps()
    const response = await handleMastraFactoryApprovalsList(get('approvals', 'Bearer nope'), 'prj_x', d)
    assert.equal(response.status, 401)
    assert.deepEqual(d.calls, ['failedAuth'])
  })

  it('unknown key for the project answers 401 via the failed-auth limiter', async () => {
    const d = deps()
    d.authenticate = async () => {
      d.calls.push('authenticate')
      return null
    }
    const response = await handleMastraFactoryApprovalsList(get('approvals', `Bearer ${KEY}`), 'prj_x', d)
    assert.equal(response.status, 401)
    assert.deepEqual(d.calls, ['authenticate', 'failedAuth'])
  })

  it('rate-limited read returns the limiter response untouched, feed not consulted', async () => {
    const limited = NextResponse.json({ error: 'rate limited' }, { status: 429 })
    const d = deps({ applyRestReadLimit: async () => limited })
    const response = await handleMastraFactoryApprovalsList(get('approvals', `Bearer ${KEY}`), 'prj_x', d)
    assert.equal(response, limited)
    assert.ok(!d.calls.includes('listOpen'))
  })

  it('non-mastra-factory project answers 404, the feed is never opened', async () => {
    const d = deps({
      authenticate: async () => ({ project: { plugin: 'http', workspaceId: 'wsp_1' } }),
    })
    const response = await handleMastraFactoryApprovalsList(get('approvals', `Bearer ${KEY}`), 'prj_x', d)
    assert.equal(response.status, 404)
    assert.ok(!d.calls.includes('listOpen'))
  })

  it('happy path returns the gate feed scoped to the authenticated project and workspace', async () => {
    const feed = {
      approvals: [
        {
          id: 'apv_1',
          status: 'pending',
          decision: null,
          gate: 'plan',
          metadata: { 'net.hitly/gate': 'plan', 'net.hitly/factory/session-id': 'sess-1' },
        },
      ],
    }
    const seen: unknown[] = []
    const d = deps({
      listOpen: async (projectId, workspaceId) => {
        seen.push(projectId, workspaceId)
        return feed
      },
    })
    const response = await handleMastraFactoryApprovalsList(get('approvals', `Bearer ${KEY}`), 'prj_x', d)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), feed)
    assert.deepEqual(seen, ['prj_x', 'wsp_1'])
  })
})

describe('GET /api/v1/projects/:id/integrations/mastra-factory/approvals/:approvalId', () => {
  const state: MastraFactoryApprovalState = {
    id: 'apv_1',
    status: 'decided',
    decision: 'accept',
    metadata: { 'net.hitly/gate': 'review', 'net.hitly/factory/session-id': 'sess-1' },
    reason: 'ship it',
  }

  it('missing API key answers 401 before the authority is consulted', async () => {
    const d = deps()
    const response = await handleMastraFactoryApprovalGet(get('approvals/apv_1', null), 'prj_x', 'apv_1', d)
    assert.equal(response.status, 401)
    assert.deepEqual(d.calls, [])
  })

  it('happy path returns the authoritative state for the requested approval', async () => {
    const seen: unknown[] = []
    const d = deps({
      readState: async (projectId, workspaceId, approvalId) => {
        seen.push(projectId, workspaceId, approvalId)
        return state
      },
    })
    const response = await handleMastraFactoryApprovalGet(get('approvals/apv_1', `Bearer ${KEY}`), 'prj_x', 'apv_1', d)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), state)
    assert.deepEqual(seen, ['prj_x', 'wsp_1', 'apv_1'])
  })

  it('an approval outside the project answers 404, never a null-shaped 200', async () => {
    const d = deps() // readState stub returns null
    const response = await handleMastraFactoryApprovalGet(get('approvals/apv_zzz', `Bearer ${KEY}`), 'prj_x', 'apv_zzz', d)
    assert.equal(response.status, 404)
    assert.ok(d.calls.includes('readState'))
  })
})
