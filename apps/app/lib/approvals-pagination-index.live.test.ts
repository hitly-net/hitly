/**
 * Live Postgres: the keyset list index must actually be used.
 *
 * Mutant: index built with DESC NULLS LAST while queries emit ORDER BY
 * created_at DESC (NULLS FIRST) → seq scan + Sort. This file goes red.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { AWAITING_HUMAN_APPROVAL_STATUSES } from '@hitly/core'
import { approvals, decisionRecords, memberships, projectApiKeys, projects, users, workspaces } from '@hitly/db/schema'
import { generateApiKey } from './keys'
import { newId } from './ids'
import { olderThanListCursor, type ListCursor } from './list-cursor'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://hitly:hitly@localhost:5432/hitly'
const INDEX = 'approvals_workspace_created_at_id_idx'
const SEED = 2500
const PAGE = 10

type PlanNode = {
  'Node Type'?: string
  'Index Name'?: string
  'Sort Key'?: string[]
  Plans?: PlanNode[]
}

let client: pg.Client
let db: ReturnType<typeof drizzle>
const workspace = { id: newId('wsp'), name: 'Idx Workspace', slug: `idx-${Date.now()}` }
const reviewer = { id: newId('usr'), email: `idx-${Date.now()}@test.hitly.net`, name: 'Idx Reviewer' }
const project = { id: newId('prj'), workspaceId: workspace.id, name: 'Idx Project' }
let keyId = ''
let cursor: ListCursor

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  // @ts-expect-error - Client vs Pool type mismatch, works at runtime
  db = drizzle(client)
  await db.insert(workspaces).values(workspace)
  await db.insert(users).values({ ...reviewer, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(memberships).values({
    id: newId('mem'),
    workspaceId: workspace.id,
    userId: reviewer.id,
    role: 'admin',
    createdAt: new Date(),
  })
  await db.insert(projects).values({
    ...project,
    plugin: 'mastra',
    credentials: {},
    evidenceSinkType: 'none',
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  const gen = generateApiKey()
  keyId = newId('key')
  await db.insert(projectApiKeys).values({
    id: keyId,
    projectId: project.id,
    workspaceId: workspace.id,
    hashedKey: gen.hashed,
    prefix: gen.prefix,
    name: 'idx key',
    createdAt: new Date(),
  })
  const base = Date.now()
  const expiresAt = new Date(base + 3_600_000)
  for (let offset = 0; offset < SEED; offset += 500) {
    const batch = Array.from({ length: Math.min(500, SEED - offset) }, (_, i) => {
      const n = offset + i
      return {
        id: newId('apr').slice(0, 36),
        workspaceId: workspace.id,
        projectId: project.id,
        plugin: 'mastra' as const,
        status: 'pending' as const,
        actionName: `idx-${n}`,
        envelope: { n },
        origin: { n },
        requesterKeyId: keyId,
        expiresAt,
        createdAt: new Date(base + n),
      }
    })
    await db.insert(approvals).values(batch)
  }
  const [pageEnd] = await db
    .select({ id: approvals.id, createdAt: approvals.createdAt })
    .from(approvals)
    .where(eq(approvals.workspaceId, workspace.id))
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(1)
    .offset(PAGE)
  if (!pageEnd) throw new Error('seed too small for a cursor page')
  cursor = { createdAt: pageEnd.createdAt, id: pageEnd.id }
  await client.query('ANALYZE approvals')
})

after(async () => {
  if (db) {
    await db.delete(approvals).where(eq(approvals.workspaceId, workspace.id))
    await db.delete(projectApiKeys).where(eq(projectApiKeys.workspaceId, workspace.id))
    await db.delete(projects).where(eq(projects.workspaceId, workspace.id))
    await db.delete(memberships).where(eq(memberships.workspaceId, workspace.id))
    await db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    await db.delete(users).where(eq(users.id, reviewer.id))
  }
  if (client) await client.end()
})

function walk(node: PlanNode, acc: PlanNode[] = []): PlanNode[] {
  acc.push(node)
  for (const child of node.Plans ?? []) walk(child, acc)
  return acc
}

function skipLimit(node: PlanNode): PlanNode {
  let current = node
  while (current['Node Type'] === 'Limit' && current.Plans?.[0]) current = current.Plans[0]
  return current
}

function inboxQuery(scope: 'all' | 'open', listCursor?: ListCursor) {
  const now = new Date()
  const filters = [eq(approvals.workspaceId, workspace.id), inArray(approvals.projectId, [project.id])]
  if (scope === 'open') {
    filters.push(inArray(approvals.status, [...AWAITING_HUMAN_APPROVAL_STATUSES]))
    const notPastDeadline = or(sql`${approvals.expiresAt} is null`, gte(approvals.expiresAt, now))
    if (notPastDeadline) filters.push(notPastDeadline)
  }
  const cursorWhere = listCursor ? olderThanListCursor(approvals.createdAt, approvals.id, listCursor) : undefined
  if (cursorWhere) filters.push(cursorWhere)
  return db
    .select({
      id: approvals.id,
      createdAt: approvals.createdAt,
      decision: sql<string | null>`(
        select ${decisionRecords.decision}
        from ${decisionRecords}
        where ${decisionRecords.approvalId} = ${approvals.id}
        order by ${decisionRecords.createdAt} desc
        limit 1
      )`.as('decision'),
    })
    .from(approvals)
    .innerJoin(projects, eq(approvals.projectId, projects.id))
    .where(and(...filters))
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(PAGE + 1)
}

function requesterQuery(listCursor?: ListCursor) {
  const now = new Date()
  const filters = [
    eq(approvals.workspaceId, workspace.id),
    eq(approvals.projectId, project.id),
    eq(approvals.requesterKeyId, keyId),
    and(
      inArray(approvals.status, [...AWAITING_HUMAN_APPROVAL_STATUSES]),
      or(sql`${approvals.expiresAt} is null`, gte(approvals.expiresAt, now)),
    ),
  ]
  const cursorWhere = listCursor ? olderThanListCursor(approvals.createdAt, approvals.id, listCursor) : undefined
  if (cursorWhere) filters.push(cursorWhere)
  return db
    .select({
      id: approvals.id,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(and(...filters))
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(PAGE + 1)
}

async function explain(label: string, query: ReturnType<typeof inboxQuery> | ReturnType<typeof requesterQuery>) {
  const compiled = query.toSQL()
  assert.doesNotMatch(compiled.sql, /nulls last/i, `${label} ORDER BY must be DESC (NULLS FIRST), not NULLS LAST`)
  const json = await client.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (FORMAT JSON) ${compiled.sql}`, compiled.params)
  const text = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${compiled.sql}`, compiled.params)
  const plan = json.rows[0]?.['QUERY PLAN'][0]?.Plan
  assert.ok(plan, `${label} EXPLAIN returned no plan`)
  const nodes = walk(plan)
  const used = nodes.some((node) => node['Index Name'] === INDEX)
  const outer = skipLimit(plan)
  const dump = text.rows.map((row) => row['QUERY PLAN']).join('\n')
  assert.ok(used, `${label} must use ${INDEX}\n${dump}`)
  assert.notEqual(
    outer['Node Type'],
    'Sort',
    `${label} must not Sort the list; the index must supply created_at DESC, id DESC\n${dump}`,
  )
  assert.notEqual(outer['Node Type'], 'Incremental Sort', `${label} must not Incremental Sort the list\n${dump}`)
  return dump
}

test('indexdef NULLS order matches ORDER BY created_at DESC, id DESC', async () => {
  const idx = await client.query<{ indexdef: string }>(
    `select indexdef from pg_indexes where tablename = 'approvals' and indexname = $1`,
    [INDEX],
  )
  assert.equal(idx.rows.length, 1)
  const indexdef = idx.rows[0]!.indexdef
  assert.match(indexdef, /workspace_id/)
  assert.match(indexdef, /created_at DESC(?! NULLS LAST)/)
  assert.match(indexdef, /id DESC(?! NULLS LAST)/)
  assert.doesNotMatch(indexdef, /NULLS LAST/)
})

test('EXPLAIN of inbox and requester list SQL uses the index with no list Sort', async () => {
  await client.query('BEGIN')
  await client.query('SET LOCAL enable_seqscan = off')
  // created_at_idx + Incremental Sort can win at single-workspace skew (S2).
  // Turning sort off requires an index that already matches ORDER BY DESC.
  await client.query('SET LOCAL enable_sort = off')
  await client.query('SET LOCAL enable_incremental_sort = off')
  try {
    await explain('inbox all first page', inboxQuery('all'))
    await explain('inbox all cursor page', inboxQuery('all', cursor))
    await explain('inbox open first page', inboxQuery('open'))
    await explain('inbox open cursor page', inboxQuery('open', cursor))
    await explain('requester first page', requesterQuery())
    await explain('requester cursor page', requesterQuery(cursor))
  } finally {
    await client.query('ROLLBACK')
  }
})
