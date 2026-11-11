/**
 * Project lifecycle: live / paused / archived / delete.
 * Run with: yarn db:up && yarn test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import {
  approvals,
  decisionRecords,
  evidenceReceipts,
  memberships,
  projectApiKeys,
  projectChannels,
  projectEvents,
  projectMemberships,
  projects,
  users,
  workspaces,
} from '@hitly/db/schema'
import { POST as ingestRoute } from '../app/api/v1/approvals/route'
import { decideApproval, ingestApproval } from './approvals'
import { db, pool } from './db'
import { newId } from './ids'
import { generateApiKey } from './keys'
import { listInboxItems } from './inbox'
import { parseProjectConfig, saveProjectConfig } from './project-config'
import {
  PROJECT_ARCHIVED_CODE,
  PROJECT_ARCHIVED_ERROR,
  PROJECT_NAME_MISMATCH_CODE,
  PROJECT_NOT_ARCHIVED_CODE,
  PROJECT_PAUSED_CODE,
  PROJECT_PAUSED_ERROR,
  canUseProjectLifecycle,
  deleteProject,
  ingestBlockedForProjectStatus,
  mutationBlockedForProjectStatus,
  setCanUseProjectLifecycleForTests,
  setProjectStatus,
} from './project-lifecycle'
import { listVisibleProjectIds } from './rbac'
import { withTenant } from './tenant'
import { encodeTenantJson } from './tenant-crypto'

if (!process.env.HITLY_ENCRYPTION_KEK) {
  throw new Error('HITLY_ENCRYPTION_KEK required for tests')
}
if (!db) {
  throw new Error('DATABASE_URL required for tests')
}
const database = db

const workspaceId = newId('wsp')
const adminId = newId('usr')
const memberId = newId('usr')
const workspace = { id: workspaceId, plan: 'self-hosted' }

function httpBody(): Record<string, unknown> {
  return { runId: newId('run'), actionName: 'refund', args: { amount: 1 } }
}

async function insertProject(name: string) {
  const projectId = newId('prj').slice(0, 36)
  const key = generateApiKey()
  await database.insert(projects).values({
    id: projectId,
    workspaceId,
    name,
    plugin: 'http',
    credentials: await encodeTenantJson(workspaceId, { plugin: 'http' }),
    defaultAssigneeUserId: adminId,
    defaultSlaMinutes: '1440',
    evidenceSinkType: 'none',
  })
  await database.insert(projectMemberships).values({
    id: newId('pm').slice(0, 36),
    workspaceId,
    projectId,
    userId: adminId,
    role: 'admin',
  })
  await database.insert(projectMemberships).values({
    id: newId('pm').slice(0, 36),
    workspaceId,
    projectId,
    userId: memberId,
    role: 'user',
  })
  await database.insert(projectApiKeys).values({
    id: newId('key').slice(0, 36),
    workspaceId,
    projectId,
    name: 'ingest',
    hashedKey: key.hashed,
    prefix: key.prefix,
  })
  return { projectId, apiKey: key.raw }
}

async function ingest(apiKey: string, body = httpBody()) {
  return ingestApproval({ apiKey, body })
}

before(async () => {
  await database.insert(workspaces).values({
    id: workspaceId,
    name: 'Lifecycle WS',
    slug: `lifecycle-${workspaceId.slice(-8)}`,
  })
  await database.insert(users).values({
    id: adminId,
    email: `admin-${adminId.slice(-8)}@example.com`,
    name: 'Lifecycle Admin',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await database.insert(users).values({
    id: memberId,
    email: `member-${memberId.slice(-8)}@example.com`,
    name: 'Lifecycle Member',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await database.insert(memberships).values({
    id: newId('mem'),
    workspaceId,
    userId: adminId,
    role: 'admin',
    createdAt: new Date(),
  })
  await database.insert(memberships).values({
    id: newId('mem'),
    workspaceId,
    userId: memberId,
    role: 'member',
    createdAt: new Date(),
  })
})

after(async () => {
  setCanUseProjectLifecycleForTests(null)
  await database.delete(evidenceReceipts).where(eq(evidenceReceipts.workspaceId, workspaceId))
  await database.delete(decisionRecords).where(eq(decisionRecords.workspaceId, workspaceId))
  await database.delete(approvals).where(eq(approvals.workspaceId, workspaceId))
  await database.delete(projectEvents).where(eq(projectEvents.workspaceId, workspaceId))
  await database.delete(projectApiKeys).where(eq(projectApiKeys.workspaceId, workspaceId))
  await database.delete(projectChannels).where(eq(projectChannels.workspaceId, workspaceId))
  await database.delete(projectMemberships).where(eq(projectMemberships.workspaceId, workspaceId))
  await database.delete(projects).where(eq(projects.workspaceId, workspaceId))
  await database.delete(memberships).where(eq(memberships.workspaceId, workspaceId))
  await database.delete(workspaces).where(eq(workspaces.id, workspaceId))
  await database.delete(users).where(eq(users.id, adminId))
  await database.delete(users).where(eq(users.id, memberId))
  await pool?.end()
})

describe('project lifecycle contract', () => {
  it('tier hook returns true for every current plan', () => {
    for (const plan of ['self-hosted', 'solo', 'pro', 'team', 'enterprise']) {
      assert.equal(canUseProjectLifecycle({ plan }), true, plan)
    }
  })

  it('paused and archived ingest refusals use 409 and stable codes', () => {
    assert.deepEqual(ingestBlockedForProjectStatus('paused'), {
      ok: false,
      error: PROJECT_PAUSED_ERROR,
      code: PROJECT_PAUSED_CODE,
      status: 409,
    })
    assert.equal(PROJECT_PAUSED_ERROR, 'project paused')
    assert.deepEqual(ingestBlockedForProjectStatus('archived'), {
      ok: false,
      error: PROJECT_ARCHIVED_ERROR,
      code: PROJECT_ARCHIVED_CODE,
      status: 409,
    })
    assert.equal(PROJECT_ARCHIVED_ERROR, 'project archived')
    assert.equal(ingestBlockedForProjectStatus('live'), null)
    assert.deepEqual(mutationBlockedForProjectStatus('archived'), {
      ok: false,
      error: PROJECT_ARCHIVED_ERROR,
      code: PROJECT_ARCHIVED_CODE,
      status: 409,
    })
    assert.equal(mutationBlockedForProjectStatus('paused'), null)
    assert.equal(mutationBlockedForProjectStatus('live'), null)
  })

  it('ingestApproval and decideApproval call the lifecycle gates (fail if enforcement is removed)', () => {
    const approvalsSrc = readFileSync(new URL('./approvals.ts', import.meta.url), 'utf8')
    assert.match(approvalsSrc, /ingestBlockedForProjectStatus\(project\.status\)/)
    assert.match(approvalsSrc, /refuseIfProjectArchived/)
    const actionsSrc = readFileSync(new URL('../actions/projects.ts', import.meta.url), 'utf8')
    assert.match(actionsSrc, /setProjectStatus/)
    assert.match(actionsSrc, /deleteProjectRecord/)
    assert.match(actionsSrc, /canManageWorkspace\(role\)/)
    const mcpHost = readFileSync(new URL('../../../apps/mcp/src/host-client.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(mcpHost, /pauseProject|archiveProject|unarchiveProject|setProjectStatus/)
    const pluginHttp = readFileSync(new URL('../../../packages/plugin-http/src/index.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(pluginHttp, /pauseProject|archiveProject|setProjectStatus/)
  })
})

describe('paused project', () => {
  it('refuses new requests with 409 project paused and still allows decide', async () => {
    const { projectId, apiKey } = await insertProject('Paused Refunds')
    const created = await withTenant(workspaceId, () => ingest(apiKey))
    if (!created.ok) throw new Error(created.error)
    assert.equal(created.ok, true)

    const paused = await withTenant(workspaceId, () =>
      setProjectStatus({ projectId, status: 'paused', workspaceRole: 'admin', workspace }),
    )
    assert.equal(paused.ok, true)

    const refused = await withTenant(workspaceId, () => ingest(apiKey))
    assert.equal(refused.ok, false)
    if (refused.ok) throw new Error('paused ingest must fail')
    assert.equal(refused.status, 409)
    assert.equal(refused.code, PROJECT_PAUSED_CODE)
    assert.equal(refused.error, 'project paused')

    const route = await ingestRoute(
      new Request('http://localhost/api/v1/approvals', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(httpBody()),
      }),
    )
    assert.equal(route.status, 409)
    assert.deepEqual(await route.json(), { error: 'project paused', code: 'project_paused' })

    const decided = await decideApproval({
      approvalId: created.approval.id,
      actorUserId: adminId,
      payload: { decision: 'accept' },
      workspaceId,
    })
    assert.equal('error' in decided && decided.error === PROJECT_PAUSED_ERROR, false, JSON.stringify(decided))
    const [row] = await database.select().from(approvals).where(eq(approvals.id, created.approval.id))
    assert.ok(row)
    assert.ok(row.status === 'decided' || row.status === 'failed_resume', row.status)
  })
})

describe('archived project', () => {
  it('is hidden from inbox and lists, is read-only, and unarchive restores live', async () => {
    const { projectId, apiKey } = await insertProject('Archive Me')
    const created = await withTenant(workspaceId, () => ingest(apiKey))
    if (!created.ok) throw new Error(created.error)
    assert.equal(created.ok, true)

    const visibleBefore = await listVisibleProjectIds({
      workspaceId,
      userId: adminId,
      workspaceRole: 'admin',
    })
    assert.ok(visibleBefore.includes(projectId))

    const archived = await withTenant(workspaceId, () =>
      setProjectStatus({ projectId, status: 'archived', workspaceRole: 'admin', workspace }),
    )
    assert.equal(archived.ok, true)

    const visibleAfter = await listVisibleProjectIds({
      workspaceId,
      userId: adminId,
      workspaceRole: 'admin',
    })
    assert.equal(visibleAfter.includes(projectId), false)

    const inbox = await listInboxItems({
      workspaceId,
      userId: adminId,
      workspaceRole: 'admin',
      projectId,
    })
    assert.equal(inbox.items.length, 0)

    const ingestRefused = await withTenant(workspaceId, () => ingest(apiKey))
    assert.equal(ingestRefused.ok, false)
    if (ingestRefused.ok) throw new Error('archived ingest must fail')
    assert.equal(ingestRefused.status, 409)
    assert.equal(ingestRefused.code, PROJECT_ARCHIVED_CODE)
    assert.equal(ingestRefused.error, 'project archived')

    const decided = await decideApproval({
      approvalId: created.approval.id,
      actorUserId: adminId,
      payload: { decision: 'reject' },
      workspaceId,
    })
    assert.equal('error' in decided, true)
    if (!('error' in decided)) throw new Error('archived decide must fail')
    assert.equal(decided.error, 'project archived')
    assert.equal(decided.status, 409)
    assert.equal('code' in decided && decided.code, PROJECT_ARCHIVED_CODE)

    const parsed = parseProjectConfig({ name: 'Archive Me (edited)', sla: '30' })
    assert.ok(!('error' in parsed))
    const saved = await withTenant(workspaceId, () => saveProjectConfig(projectId, parsed))
    assert.equal('error' in saved, true)
    if (!('error' in saved)) throw new Error('archived config must fail')
    assert.equal(saved.error, 'project archived')

    const unarchived = await withTenant(workspaceId, () =>
      setProjectStatus({ projectId, status: 'live', workspaceRole: 'admin', workspace }),
    )
    assert.equal(unarchived.ok, true)
    const liveAgain = await withTenant(workspaceId, () => ingest(apiKey))
    assert.equal(liveAgain.ok, true, liveAgain.ok ? '' : liveAgain.error)
  })
})

describe('delete', () => {
  it('is refused unless the project is archived, and then removes items', async () => {
    const { projectId, apiKey } = await insertProject('Delete Me')
    const created = await withTenant(workspaceId, () => ingest(apiKey))
    if (!created.ok) throw new Error(created.error)
    assert.equal(created.ok, true)

    const liveDelete = await withTenant(workspaceId, () =>
      deleteProject({
        projectId,
        workspaceRole: 'admin',
        workspace,
        confirmName: 'Delete Me',
      }),
    )
    assert.equal(liveDelete.ok, false)
    if (liveDelete.ok) throw new Error('live delete must fail')
    assert.equal(liveDelete.status, 409)
    assert.equal(liveDelete.code, PROJECT_NOT_ARCHIVED_CODE)
    const [stillThere] = await database.select().from(projects).where(eq(projects.id, projectId))
    assert.ok(stillThere)
    const [itemStill] = await database.select().from(approvals).where(eq(approvals.id, created.approval.id))
    assert.ok(itemStill)

    const archived = await withTenant(workspaceId, () =>
      setProjectStatus({ projectId, status: 'archived', workspaceRole: 'admin', workspace }),
    )
    assert.equal(archived.ok, true)

    const removed = await withTenant(workspaceId, () =>
      deleteProject({
        projectId,
        workspaceRole: 'admin',
        workspace,
        confirmName: 'Delete Me',
      }),
    )
    assert.equal(removed.ok, true)
    const [gone] = await database.select().from(projects).where(eq(projects.id, projectId))
    assert.equal(gone, undefined)
    const leftoverItems = await database.select().from(approvals).where(eq(approvals.projectId, projectId))
    assert.equal(leftoverItems.length, 0)
    const leftoverDecisions = await database
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.workspaceId, workspaceId))
    assert.equal(
      leftoverDecisions.filter((row) => row.approvalId === created.approval.id).length,
      0,
    )
  })
})

describe('workspace-admin only', () => {
  it('refuses pause, archive, and delete from a member', async () => {
    const { projectId } = await insertProject('Member Guard')
    const paused = await withTenant(workspaceId, () =>
      setProjectStatus({ projectId, status: 'paused', workspaceRole: 'member', workspace }),
    )
    assert.equal(paused.ok, false)
    if (paused.ok) throw new Error('member pause must fail')
    assert.equal(paused.status, 403)

    const archived = await withTenant(workspaceId, () =>
      setProjectStatus({ projectId, status: 'archived', workspaceRole: 'member', workspace }),
    )
    assert.equal(archived.ok, false)
    if (archived.ok) throw new Error('member archive must fail')
    assert.equal(archived.status, 403)

    await withTenant(workspaceId, () =>
      setProjectStatus({ projectId, status: 'archived', workspaceRole: 'admin', workspace }),
    )
    const deleted = await withTenant(workspaceId, () =>
      deleteProject({
        projectId,
        workspaceRole: 'member',
        workspace,
        confirmName: 'Member Guard',
      }),
    )
    assert.equal(deleted.ok, false)
    if (deleted.ok) throw new Error('member delete must fail')
    assert.equal(deleted.status, 403)
    const [still] = await database.select().from(projects).where(eq(projects.id, projectId))
    assert.ok(still)
  })
})

describe('tier hook direct-delete path', () => {
  it('requires the typed project name to match and refuses a wrong name', async () => {
    const { projectId, apiKey } = await insertProject('Confirm Name')
    await withTenant(workspaceId, () => ingest(apiKey))
    setCanUseProjectLifecycleForTests(() => false)
    try {
      assert.equal(canUseProjectLifecycle(workspace), false)

      const pause = await withTenant(workspaceId, () =>
        setProjectStatus({ projectId, status: 'paused', workspaceRole: 'admin', workspace }),
      )
      assert.equal(pause.ok, false)
      if (pause.ok) throw new Error('pause must be gated')
      assert.equal(pause.code, 'lifecycle_unavailable')

      const wrong = await withTenant(workspaceId, () =>
        deleteProject({
          projectId,
          workspaceRole: 'admin',
          workspace,
          confirmName: 'wrong-name',
        }),
      )
      assert.equal(wrong.ok, false)
      if (wrong.ok) throw new Error('wrong name must fail')
      assert.equal(wrong.status, 400)
      assert.equal(wrong.code, PROJECT_NAME_MISMATCH_CODE)
      const [still] = await database.select().from(projects).where(eq(projects.id, projectId))
      assert.ok(still)
      assert.equal(still.status, 'live')

      const ok = await withTenant(workspaceId, () =>
        deleteProject({
          projectId,
          workspaceRole: 'admin',
          workspace,
          confirmName: 'Confirm Name',
        }),
      )
      assert.equal(ok.ok, true)
      const [gone] = await database.select().from(projects).where(eq(projects.id, projectId))
      assert.equal(gone, undefined)
    } finally {
      setCanUseProjectLifecycleForTests(null)
    }
  })
})

describe('migration 0010_project_status', () => {
  it('adds status default live with a project_status enum', async () => {
    const { projectId } = await insertProject('Default Live')
    const [row] = await database.select().from(projects).where(eq(projects.id, projectId))
    assert.equal(row.status, 'live')

    const cols = await database.execute(
      sql`select column_default, is_nullable from information_schema.columns where table_name = 'projects' and column_name = 'status'`,
    )
    assert.equal(cols.rows.length, 1)
    assert.equal(cols.rows[0].is_nullable, 'NO')
    assert.match(String(cols.rows[0].column_default), /live/)

    const enums = await database.execute(
      sql`select e.enumlabel from pg_type t join pg_enum e on t.oid = e.enumtypid where t.typname = 'project_status' order by e.enumsortorder`,
    )
    assert.deepEqual(
      enums.rows.map((row) => row.enumlabel),
      ['live', 'paused', 'archived'],
    )
  })
})
