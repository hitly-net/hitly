/**
 * Web inbox and project item lists must follow nextCursor so a reviewer
 * never silently loses items past page 1 (default 100).
 *
 * Mutant M-web: if listInboxItemsForWeb (or the pages) ignore nextCursor and
 * only take the first page, item 101 is missing and this file goes red.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { approvals, memberships, projectApiKeys, projects, users, workspaces } from '@hitly/db/schema'
import { INBOX_DEFAULT_LIMIT, WEB_INBOX_FETCH_CAP, listInboxItems, listInboxItemsForWeb } from './inbox'
import { encodeTenantJson } from './tenant-crypto'
import { generateApiKey } from './keys'
import { newId } from './ids'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://hitly:hitly@localhost:5432/hitly'
if (!process.env.HITLY_ENCRYPTION_KEK) throw new Error('HITLY_ENCRYPTION_KEK required for tests')

const dir = path.dirname(fileURLToPath(import.meta.url))

let client: pg.Client
let db: ReturnType<typeof drizzle>
const workspace = { id: newId('wsp'), name: 'Web page workspace', slug: `web-page-${Date.now()}` }
const reviewer = { id: newId('usr'), email: `web-page-${Date.now()}@test.hitly.net`, name: 'Web Page Reviewer' }
const project = { id: newId('prj'), workspaceId: workspace.id, name: 'Web Page Project' }
let keyId: string

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
    name: 'web page key',
    createdAt: new Date(),
  })
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

test('source: inbox and project pages use listInboxItemsForWeb and show remaining items', () => {
  const inboxPage = fs.readFileSync(path.join(dir, '../app/inbox/page.tsx'), 'utf8')
  const projectPage = fs.readFileSync(path.join(dir, '../app/projects/[id]/page.tsx'), 'utf8')
  const listSrc = fs.readFileSync(path.join(dir, '../components/work-item-list.tsx'), 'utf8')
  assert.match(inboxPage, /listInboxItemsForWeb/, 'inbox page must fetch through nextCursor')
  assert.doesNotMatch(inboxPage, /await listInboxItems\(/, 'inbox page must not take a single unpaged listInboxItems call')
  assert.match(inboxPage, /hasMore/, 'inbox page must pass the honest remaining-items flag')
  assert.match(projectPage, /listInboxItemsForWeb/, 'project items page must fetch through nextCursor')
  assert.doesNotMatch(projectPage, /await listInboxItems\(/, 'project items page must not take a single unpaged listInboxItems call')
  assert.match(projectPage, /hasMore/, 'project items page must pass the honest remaining-items flag')
  assert.match(listSrc, /hasMore/, 'WorkItemList must accept hasMore')
  assert.match(listSrc, /More items remain beyond this list/, 'WorkItemList must show remaining items')
  assert.equal(INBOX_DEFAULT_LIMIT, 100)
  assert.equal(WEB_INBOX_FETCH_CAP, 500)
  assert.ok(WEB_INBOX_FETCH_CAP > INBOX_DEFAULT_LIMIT, 'web fetch cap must be past page 1')
})

test('web inbox: item 101 is reachable; remaining rows past the cap are not silent', async () => {
  const envelope = await encodeTenantJson(workspace.id, { action: { name: 'pay', args: {} } })
  const origin = await encodeTenantJson(workspace.id, { runId: 'web-page' })
  const total = 101
  const base = Date.now()
  const rows = []
  for (let i = 0; i < total; i++) {
    rows.push({
      id: newId('apr').slice(0, 36),
      workspaceId: workspace.id,
      projectId: project.id,
      plugin: 'mastra' as const,
      status: 'pending' as const,
      actionName: `reach-${i}`,
      envelope,
      origin,
      requesterKeyId: keyId,
      expiresAt: new Date(base + 3_600_000),
      createdAt: new Date(base + i),
    })
  }
  await db.insert(approvals).values(rows)
  const oldestId = rows[0]!.id
  const newestId = rows[total - 1]!.id

  const args = {
    workspaceId: workspace.id,
    userId: reviewer.id,
    workspaceRole: 'admin' as const,
    projectId: project.id,
    scope: 'open',
  }

  const page1 = await listInboxItems({ ...args, limit: INBOX_DEFAULT_LIMIT })
  assert.equal(page1.items.length, INBOX_DEFAULT_LIMIT)
  assert.equal(typeof page1.nextCursor, 'string')
  assert.equal(
    page1.items.some((item) => item.id === oldestId),
    false,
    'page 1 of 100 must not include item 101 (oldest)',
  )

  const all = await listInboxItemsForWeb(args)
  assert.equal(all.items.length, total, 'following nextCursor must reach past page 1')
  assert.equal(all.items[0]?.id, newestId)
  assert.equal(all.items[total - 1]?.id, oldestId, 'item 101 (oldest) must be reachable')
  assert.equal(all.hasMore, false)
  assert.equal(all.nextCursor, null)

  const capped = await listInboxItemsForWeb(args, INBOX_DEFAULT_LIMIT)
  assert.equal(capped.items.length, INBOX_DEFAULT_LIMIT)
  assert.equal(capped.hasMore, true, 'hitting the cap with rows remaining must set hasMore')
  assert.equal(
    capped.items.some((item) => item.id === oldestId),
    false,
    'the cap must not pretend the truncated tail was shown',
  )
})
