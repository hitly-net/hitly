/**
 * New projects can only use a listed plugin, and projects that already use
 * OpenShell keep working: config edits, ingest and decide. Runs against real
 * Postgres (not mocked).
 *
 * Run with: yarn db:up && yarn test
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { and, eq, inArray } from 'drizzle-orm'
import { LISTED_PLUGIN_IDS } from '@hitly/core'
import {
  approvals,
  decisionRecords,
  evidenceReceipts,
  memberships,
  projectApiKeys,
  projectChannels,
  projectMemberships,
  projects,
  users,
  workspaces,
} from '@hitly/db/schema'
import {
  __resetOpenShellClientFactory,
  __setOpenShellClientFactory,
  type OpenShellClientFactory,
} from '@hitly/plugin-openshell'
import { decideApproval, ingestApproval } from './approvals'
import { db, pool } from './db'
import { newId } from './ids'
import { generateApiKey } from './keys'
import { parseProjectConfig, saveProjectConfig } from './project-config'
import { insertNewProject } from './project-create'
import { requireDb, withTenant } from './tenant'
import { decodeTenantJson, encodeTenantJson } from './tenant-crypto'

if (!process.env.HITLY_ENCRYPTION_KEK) {
  throw new Error('HITLY_ENCRYPTION_KEK required for tests')
}
if (!db) {
  throw new Error('DATABASE_URL required for tests')
}
const database = db

const workspaceId = newId('wsp')
const userId = newId('usr')

async function projectRows() {
  return database.select().from(projects).where(eq(projects.workspaceId, workspaceId))
}

function create(plugin: unknown, name = 'Refunds') {
  return withTenant(workspaceId, () => insertNewProject({ userId, name, description: '', plugin }))
}

before(async () => {
  await database.insert(workspaces).values({ id: workspaceId, name: 'Project create', slug: `project-create-${workspaceId.slice(-8)}` })
  await database.insert(users).values({
    id: userId,
    email: `admin-${userId.slice(-8)}@example.com`,
    name: 'Admin User',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await database.insert(memberships).values({ id: newId('mem'), workspaceId, userId, role: 'admin', createdAt: new Date() })
})

after(async () => {
  __resetOpenShellClientFactory()
  await database.delete(evidenceReceipts).where(eq(evidenceReceipts.workspaceId, workspaceId))
  await database.delete(decisionRecords).where(eq(decisionRecords.workspaceId, workspaceId))
  await database.delete(approvals).where(eq(approvals.workspaceId, workspaceId))
  await database.delete(projectApiKeys).where(eq(projectApiKeys.workspaceId, workspaceId))
  await database.delete(projectChannels).where(eq(projectChannels.workspaceId, workspaceId))
  await database.delete(projectMemberships).where(eq(projectMemberships.workspaceId, workspaceId))
  await database.delete(projects).where(eq(projects.workspaceId, workspaceId))
  await database.delete(memberships).where(eq(memberships.workspaceId, workspaceId))
  await database.delete(workspaces).where(eq(workspaces.id, workspaceId))
  await database.delete(users).where(eq(users.id, userId))
  await pool?.end()
})

describe('creating a project', () => {
  it('refuses OpenShell and writes nothing', async () => {
    const before = (await projectRows()).length
    for (const plugin of ['openshell', 'OpenShell', ' openshell', 'openshell ', 'open-shell']) {
      await assert.rejects(() => create(plugin, `Sandbox ${plugin}`), /Choose a plugin/, JSON.stringify(plugin))
    }
    const rows = await projectRows()
    assert.equal(rows.length, before, 'no project row is written')
    assert.equal(rows.some((row) => row.plugin === 'openshell'), false)
    assert.equal(rows.some((row) => /Sandbox/.test(row.name)), false, 'the refused name is not stored under another plugin')
  })

  it('refuses unknown or missing plugins', async () => {
    const before = (await projectRows()).length
    for (const plugin of ['nope', '', null, undefined]) {
      await assert.rejects(() => create(plugin), /Choose a plugin/, String(plugin))
    }
    assert.equal((await projectRows()).length, before)
  })

  it('creates a project with each listed plugin, stored as chosen', async () => {
    for (const plugin of LISTED_PLUGIN_IDS) {
      const projectId = await create(plugin, `Listed ${plugin}`)
      const [row] = await database.select().from(projects).where(eq(projects.id, projectId))
      assert.ok(row, plugin)
      assert.equal(row.plugin, plugin)
      assert.equal(row.name, `Listed ${plugin}`)
      const credentials = await decodeTenantJson(workspaceId, row.credentials)
      assert.equal(credentials.plugin, plugin)
      const admins = await database
        .select()
        .from(projectMemberships)
        .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)))
      assert.equal(admins[0]?.role, 'admin')
    }
  })
})

describe('existing OpenShell project', () => {
  let projectId: string
  let apiKey: string

  before(async () => {
    projectId = newId('prj').slice(0, 36)
    await database.insert(projects).values({
      id: projectId,
      workspaceId,
      name: 'Sandbox drafts',
      plugin: 'openshell',
      credentials: await encodeTenantJson(workspaceId, {
        plugin: 'openshell',
        address: 'localhost:50051',
        insecure: true,
        resumeSecret: 'existing-resume-secret',
      }),
      defaultAssigneeUserId: userId,
      defaultSlaMinutes: '60',
      evidenceSinkType: 'none',
    })
    await database.insert(projectMemberships).values({ id: newId('pm').slice(0, 36), workspaceId, projectId, userId, role: 'admin' })
    const key = generateApiKey()
    apiKey = key.raw
    await database.insert(projectApiKeys).values({
      id: newId('key'),
      workspaceId,
      projectId,
      name: 'Existing key',
      hashedKey: key.hashed,
      prefix: key.prefix,
    })
  })

  it('can still have its config edited, keeping its connection settings', async () => {
    const parsed = parseProjectConfig({ name: 'Sandbox drafts (edited)', description: 'Still in use', sla: '30', token: 'new-token' })
    assert.ok(!('error' in parsed))
    const result = await withTenant(workspaceId, () => saveProjectConfig(projectId, parsed))
    assert.deepEqual(result, { ok: true })
    const [row] = await database.select().from(projects).where(eq(projects.id, projectId))
    assert.equal(row.plugin, 'openshell')
    assert.equal(row.name, 'Sandbox drafts (edited)')
    assert.equal(row.defaultSlaMinutes, '30')
    const credentials = await decodeTenantJson(workspaceId, row.credentials)
    assert.equal(credentials.address, 'localhost:50051')
    assert.equal(credentials.insecure, true)
    assert.equal(credentials.token, 'new-token')
    assert.equal(credentials.resumeSecret, 'existing-resume-secret')
  })

  it('can still ingest and decide', async () => {
    const calls: string[] = []
    const factory: OpenShellClientFactory = {
      async connect() {
        return {
          client: {
            ApproveDraftChunk(request: { chunk_id: string }, _metadata: unknown, callback: (error: unknown, response?: unknown) => void) {
              calls.push(`approve:${request.chunk_id}`)
              callback(null, { policy_version: 7, policy_hash: 'hash-7' })
            },
            RejectDraftChunk(request: { chunk_id: string }, _metadata: unknown, callback: (error: unknown, response?: unknown) => void) {
              calls.push(`reject:${request.chunk_id}`)
              callback(null, {})
            },
          },
          connection: { close() {} },
        } as unknown as Awaited<ReturnType<OpenShellClientFactory['connect']>>
      },
    }
    __setOpenShellClientFactory(factory)

    const chunkId = newId('chunk')
    const ingested = await ingestApproval({
      apiKey,
      body: {
        plugin: 'openshell',
        projectId,
        workspace: 'default',
        sandbox: 'sandbox-1',
        chunkId,
        reviewToken: 'review-token-1',
        gatewayAddr: 'localhost:50051',
        rationale: 'Agent needs API access',
      },
    })
    assert.ok(ingested.ok, ingested.ok ? '' : ingested.error)
    assert.equal(ingested.approval.plugin, 'openshell')

    const decided = await decideApproval({
      approvalId: ingested.approval.id,
      actorUserId: userId,
      payload: { decision: 'accept' },
      workspaceId,
    })
    assert.ok(!('error' in decided && decided.error), JSON.stringify(decided))
    assert.deepEqual(calls, [`approve:${chunkId}`])

    const [approval] = await withTenant(workspaceId, () =>
      requireDb().select().from(approvals).where(eq(approvals.id, ingested.approval.id)),
    )
    assert.equal(approval.status, 'decided')
    const records = await database
      .select()
      .from(decisionRecords)
      .where(inArray(decisionRecords.approvalId, [ingested.approval.id]))
    assert.equal(records.length, 1)
  })
})

describe('project config save (LP: Config tab)', () => {
  let projectId: string

  before(async () => {
    projectId = newId('prj').slice(0, 36)
    await database.insert(projects).values({
      id: projectId,
      workspaceId,
      name: 'Mastra demo',
      plugin: 'mastra',
      credentials: await encodeTenantJson(workspaceId, {
        plugin: 'mastra',
        baseUrl: 'http://origin.invalid',
        token: 'stored-token',
        resumeSecret: 'stored-resume-secret',
      }),
      defaultSlaMinutes: '60',
      evidenceSinkType: 's3',
      evidenceSinkConfig: await encodeTenantJson(workspaceId, {
        endpoint: 'http://s3.invalid',
        region: 'local',
        bucket: 'evidence',
        accessKeyId: 'stored-access-key',
        secretAccessKey: 'stored-secret-key',
        prefix: 'hitly/',
        forcePathStyle: true,
      }),
    })
    await database.insert(projectMemberships).values({ id: newId('pm').slice(0, 36), workspaceId, projectId, userId, role: 'admin' })
  })

  async function savedRow() {
    const [row] = await database.select().from(projects).where(eq(projects.id, projectId))
    return row
  }

  it('creates new projects with the 24h (1440) default timeout', async () => {
    const created = await create('http', 'Fresh project')
    const [row] = await database.select().from(projects).where(eq(projects.id, created))
    assert.equal(row.defaultSlaMinutes, '1440')
  })

  it('parses the timeout: blank = 24h, number kept, junk refused', () => {
    const blank = parseProjectConfig({ name: 'p', sla: '' })
    assert.ok(!('error' in blank))
    assert.equal(blank.sla, '1440')
    const number = parseProjectConfig({ name: 'p', sla: '45' })
    assert.ok(!('error' in number))
    assert.equal(number.sla, '45')
    const bad = parseProjectConfig({ name: 'p', sla: 'abc' })
    assert.ok('error' in bad)
  })

  it('saves an edit: name, timeout with units semantics, and S3 fields persist', async () => {
    const parsed = parseProjectConfig({
      name: 'Mastra demo (edited)',
      description: 'demo',
      sla: '45',
      baseUrl: 'http://origin.invalid',
      token: '',
      evidenceSinkType: 's3',
      evidenceSinkS3Endpoint: 'http://s3-new.invalid',
      evidenceSinkS3Region: 'auto',
      evidenceSinkS3Bucket: 'evidence',
      evidenceSinkS3AccessKeyId: '',
      evidenceSinkS3SecretAccessKey: '',
      evidenceSinkS3Prefix: 'hitly/v2/',
      evidenceSinkS3ForcePathStyle: false,
    })
    assert.ok(!('error' in parsed))
    const result = await withTenant(workspaceId, () => saveProjectConfig(projectId, parsed))
    assert.deepEqual(result, { ok: true })
    const row = await savedRow()
    assert.equal(row.name, 'Mastra demo (edited)')
    assert.equal(row.defaultSlaMinutes, '45')
    const sink = await decodeTenantJson(workspaceId, row.evidenceSinkConfig as Record<string, unknown>)
    assert.equal(sink.endpoint, 'http://s3-new.invalid')
    assert.equal(sink.region, 'auto')
    assert.equal(sink.prefix, 'hitly/v2/')
    assert.equal(sink.forcePathStyle, false, 'an explicit uncheck persists')
  })

  it('never overwrites stored secrets when the leave-blank-to-keep fields are blank', async () => {
    const parsed = parseProjectConfig({
      name: 'Mastra demo (edited)',
      description: 'demo',
      sla: '',
      baseUrl: 'http://origin.invalid',
      token: '',
      evidenceSinkType: 's3',
      evidenceSinkS3AccessKeyId: '',
      evidenceSinkS3SecretAccessKey: '',
    })
    assert.ok(!('error' in parsed))
    const result = await withTenant(workspaceId, () => saveProjectConfig(projectId, parsed))
    assert.deepEqual(result, { ok: true })
    const row = await savedRow()
    assert.equal(row.defaultSlaMinutes, '1440', 'blank timeout means the 24h default')
    const credentials = await decodeTenantJson(workspaceId, row.credentials)
    assert.equal(credentials.token, 'stored-token', 'a blank token must never clear the stored secret')
    assert.equal(credentials.resumeSecret, 'stored-resume-secret')
    const sink = await decodeTenantJson(workspaceId, row.evidenceSinkConfig as Record<string, unknown>)
    assert.equal(sink.accessKeyId, 'stored-access-key', 'a blank S3 access key must never clear the stored one')
    assert.equal(sink.secretAccessKey, 'stored-secret-key', 'a blank S3 secret must never clear the stored one')
  })
})
