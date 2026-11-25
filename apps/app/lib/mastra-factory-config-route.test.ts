import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NextResponse } from 'next/server'
import { handleMastraFactoryConfigGet, type MastraFactoryConfigGetDeps } from './mastra-factory-config-route'

const KEY = 'hitly_' + 'a'.repeat(32)

function get(authorization: string | null): Request {
  return new Request('http://localhost:3001/api/v1/projects/prj_x/integrations/mastra-factory', {
    headers: authorization ? { authorization } : {},
  })
}

function deps(overrides: Partial<MastraFactoryConfigGetDeps> = {}): MastraFactoryConfigGetDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    authenticate: async () => {
      calls.push('authenticate')
      return { project: { plugin: 'mastra-factory', workspaceId: 'wsp_1', credentials: {} } }
    },
    applyRestReadLimit: async () => null,
    applyFailedAuth: async () => {
      calls.push('failedAuth')
      return null
    },
    decodeCredentials: async (_workspaceId, credentials) => credentials,
    ...overrides,
  }
}

describe('GET /api/v1/projects/:id/integrations/mastra-factory', () => {
  it('missing API key answers 401 before anything is consulted', async () => {
    const d = deps()
    const response = await handleMastraFactoryConfigGet(get(null), 'prj_x', d)
    assert.equal(response.status, 401)
    assert.deepEqual(d.calls, [])
  })

  it('malformed key answers 401 through the failed-auth limiter, never authenticated', async () => {
    const d = deps()
    const response = await handleMastraFactoryConfigGet(get('Bearer nope'), 'prj_x', d)
    assert.equal(response.status, 401)
    assert.deepEqual(d.calls, ['failedAuth'])
  })

  it('unknown key for the project answers 401 via the failed-auth limiter', async () => {
    const d = deps()
    d.authenticate = async () => {
      d.calls.push('authenticate')
      return null
    }
    const response = await handleMastraFactoryConfigGet(get(`Bearer ${KEY}`), 'prj_x', d)
    assert.equal(response.status, 401)
    assert.deepEqual(d.calls, ['authenticate', 'failedAuth'])
  })

  it('rate-limited read returns the limiter response untouched', async () => {
    const limited = NextResponse.json({ error: 'rate limited' }, { status: 429 })
    const d = deps({ applyRestReadLimit: async () => limited })
    const response = await handleMastraFactoryConfigGet(get(`Bearer ${KEY}`), 'prj_x', d)
    assert.equal(response, limited)
  })

  it('non-mastra-factory project answers 404, not a config-shaped 200', async () => {
    const d = deps({
      authenticate: async () => ({ project: { plugin: 'http', workspaceId: 'wsp_1', credentials: { token: 'topsecret' } } }),
    })
    const response = await handleMastraFactoryConfigGet(get(`Bearer ${KEY}`), 'prj_x', d)
    assert.equal(response.status, 404)
  })

  it('happy path returns only normalized gate state, never credentials', async () => {
    const d = deps({
      authenticate: async () => ({
        project: {
          plugin: 'mastra-factory',
          workspaceId: 'wsp_1',
          credentials: { token: 'topsecret', resumeSecret: 'hitly_resume_x', mastraFactory: { gates: { plan: false }, mergeAfterAccept: true } },
        },
      }),
      decodeCredentials: async (_workspaceId, credentials) => credentials,
    })
    const response = await handleMastraFactoryConfigGet(get(`Bearer ${KEY}`), 'prj_x', d)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body, { gates: { plan: false, review: true, ask_user: true }, mergeAfterAccept: true })
    const raw = JSON.stringify(body)
    assert.ok(!raw.includes('topsecret') && !raw.includes('hitly_resume_'), 'secrets must never appear in the response')
  })
})
