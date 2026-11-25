import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { approvals, decisionRecords, projects, workspaces } from '@hitly/db/schema'
import { db } from './db'
import { newId } from './ids'
import { encodeTenantJson } from './tenant-crypto'
import {
  getMastraFactoryApprovalState,
  handleMastraFactoryApprovalsList,
  handleMastraFactoryApprovalGet,
  listOpenMastraFactoryApprovals,
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

// ---------------------------------------------------------------------------
// Feed semantics (live Postgres): the failed_resume convergence contract.
// ---------------------------------------------------------------------------

const wspId = newId('wsp')
const prjId = newId('prj')

function gateEnvelope(gate: string) {
  return { origin: { resumeHandle: { metadata: { 'net.hitly/gate': gate, 'net.hitly/factory/session-id': 'sess-1' } } } }
}

async function plant(args: {
  id: string
  status: 'pending' | 'decided' | 'cancelled' | 'failed_resume'
  actionName: string
  gate?: string
  expiresAt?: Date | null
  decision?: 'accept' | 'reject'
}) {
  await db!
    .insert(approvals)
    .values({
      id: args.id.slice(0, 36),
      workspaceId: wspId,
      projectId: prjId,
      plugin: 'mastra-factory',
      status: args.status,
      actionName: args.actionName,
      envelope: await encodeTenantJson(wspId, args.gate ? gateEnvelope(args.gate) : { origin: {} }),
      origin: {},
      expiresAt: args.expiresAt === undefined ? new Date(Date.now() + 3_600_000) : args.expiresAt,
      createdAt: new Date(),
    })

  if (args.decision) {
    await db!
      .insert(decisionRecords)
      .values({
        id: newId('dec').slice(0, 36),
        workspaceId: wspId,
        approvalId: args.id.slice(0, 36),
        actorUserId: null,
        decision: args.decision,
        payload: await encodeTenantJson(wspId, { decision: args.decision }),
        createdAt: new Date(),
      })
      
  }
}

describe('mastra-factory feed and authority (live Postgres)', { skip: !db }, () => {
  const ids = ['apr_pend_open', 'apr_pend_stale', 'apr_fr_decided', 'apr_fr_undecided', 'apr_decided', 'apr_nogate'].map(
    (n) => `${n}_${Date.now()}`.slice(0, 36),
  )
  const [pendOpen, pendStale, frDecided, frUndecided, decided, nogate] = ids

  before(async () => {
    await db!.insert(workspaces).values({ id: wspId, name: 'MF Feed', slug: `mf-feed-${Date.now()}` })
    await db!.insert(projects).values({
      id: prjId,
      workspaceId: wspId,
      name: 'MF Feed Project',
      plugin: 'mastra-factory',
      credentials: {},
      evidenceSinkType: 'none',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const past = new Date(Date.now() - 60_000)
    await plant({ id: pendOpen, status: 'pending', actionName: 'mastra-factory/plan', gate: 'plan' })
    await plant({ id: pendStale, status: 'pending', actionName: 'mastra-factory/plan', gate: 'plan', expiresAt: past })
    // A human decided while the Factory was down; retries exhausted. The
    // deadline has since passed — it must STILL converge.
    await plant({ id: frDecided, status: 'failed_resume', actionName: 'mastra-factory/review', gate: 'review', expiresAt: past, decision: 'accept' })
    await plant({ id: frUndecided, status: 'failed_resume', actionName: 'mastra-factory/plan', gate: 'plan', expiresAt: past })
    await plant({ id: decided, status: 'decided', actionName: 'mastra-factory/plan', gate: 'plan', decision: 'accept' })
    await plant({ id: nogate, status: 'pending', actionName: 'some-other-plugin/action' })
  })

  after(async () => {
    if (!db) return
    await db.delete(approvals).where(eq(approvals.workspaceId, wspId))
    await db.delete(decisionRecords).where(eq(decisionRecords.workspaceId, wspId))
    await db.delete(projects).where(eq(projects.id, prjId))
    await db.delete(workspaces).where(eq(workspaces.id, wspId))
  })

  it('feed carries unexpired pending AND decided-but-undelivered failed_resume rows, never the rest', async () => {
    const { approvals: feed } = await listOpenMastraFactoryApprovals({ workspaceId: wspId, projectId: prjId })
    const byId = new Map(feed.map((a) => [a.id, a]))
    assert.equal(byId.has(pendOpen.slice(0, 36)), true, 'open pending belongs in the feed')
    assert.equal(byId.has(frDecided.slice(0, 36)), true, 'decided-but-undelivered failed_resume must converge')
    assert.equal(byId.has(frUndecided.slice(0, 36)), true, 'failed_resume without a decision stays in the feed until it converges')
    assert.equal(byId.has(pendStale.slice(0, 36)), false, 'a past-deadline pending row is expiry, not reconciliation')
    assert.equal(byId.has(decided.slice(0, 36)), false, 'already-delivered decisions are not reopened')
    assert.equal(byId.has(nogate.slice(0, 36)), false, 'gate-less rows are not this plugin\'s approvals')
    assert.equal(byId.get(frDecided.slice(0, 36))!.gate, 'review')
    assert.equal(byId.get(frDecided.slice(0, 36))!.metadata['net.hitly/factory/session-id'], 'sess-1')
  })

  it('authority reports a failed_resume row with its recorded decision so the reconciler can converge it', async () => {
    const state = await getMastraFactoryApprovalState({ workspaceId: wspId, projectId: prjId, approvalId: frDecided.slice(0, 36) })
    assert.ok(state)
    assert.equal(state.status, 'failed_resume')
    assert.equal(state.decision, 'accept')
    assert.equal(state.metadata['net.hitly/gate'], 'review')
  })
})
