/**
 * MCP list_pending through the real host GET /api/v1/approvals on Postgres
 * (same setup as the M0 / real-PG tests). Not FakeHost.
 *
 * HttpHostClient.listPending sends status=pending. Mutant M-pending-alias:
 * drop `status !== 'pending'` on the host list so only status=open is
 * accepted → this test goes red (400, item 101 never appears).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { approvals, memberships, projectApiKeys, projects, users, workspaces } from '@hitly/db/schema'
import { GET as listApprovals } from '../app/api/v1/approvals/route'
import { encodeTenantJson } from './tenant-crypto'
import { generateApiKey } from './keys'
import { newId } from './ids'
import { HttpHostClient } from '../../mcp/src/host-client.ts'
import { startHarness, structured } from '../../mcp/src/test-helpers.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://hitly:hitly@localhost:5432/hitly'
if (!process.env.HITLY_ENCRYPTION_KEK) throw new Error('HITLY_ENCRYPTION_KEK required for tests')

let client: pg.Client
let db: ReturnType<typeof drizzle>
const workspace = { id: newId('wsp'), name: 'MCP live list workspace', slug: `mcp-live-${Date.now()}` }
const reviewer = { id: newId('usr'), email: `mcp-live-${Date.now()}@test.hitly.net`, name: 'MCP Live Reviewer' }
const project = { id: newId('prj'), workspaceId: workspace.id, name: 'MCP Live Project' }
let keyId: string
let rawKey: string

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
  rawKey = gen.raw
  keyId = newId('key')
  await db.insert(projectApiKeys).values({
    id: keyId,
    projectId: project.id,
    workspaceId: workspace.id,
    hashedKey: gen.hashed,
    prefix: gen.prefix,
    name: 'mcp live list key',
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

test('list_pending through real GET /api/v1/approvals reaches item 101 (pending alias)', async () => {
  const routeSrc = readFileSync(new URL('../app/api/v1/approvals/route.ts', import.meta.url), 'utf8')
  assert.match(
    routeSrc,
    /status !== 'open' && status !== 'pending'/,
    'host list must keep status=pending as an exact alias of open',
  )

  const envelope = await encodeTenantJson(workspace.id, { action: { name: 'pay', args: {} } })
  const origin = await encodeTenantJson(workspace.id, { runId: 'mcp-live' })
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

  const hostCalls: string[] = []
  const fetchToHost = async (input: string, init?: RequestInit) => {
    hostCalls.push(`${init?.method ?? 'GET'} ${input}`)
    return listApprovals(new Request(input, init))
  }

  const h = await startHarness({
    deps: {
      hostFor: (key) => new HttpHostClient('https://hitly.example', key, fetchToHost),
    },
  })
  try {
    const mcp = await h.client(rawKey)
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = structured(
        await mcp.callTool({
          name: 'list_pending',
          arguments: cursor ? { projectId: project.id, cursor } : { projectId: project.id },
        }),
      ) as { items: Array<{ id: string; requestId?: string }>; nextCursor: string | null; error?: { code: string } }
      assert.equal(page.error, undefined, `list_pending must succeed against the real host list, got ${JSON.stringify(page)}`)
      for (const item of page.items) {
        assert.equal(
          item.requestId,
          item.id,
          `every MCP list_pending item must carry a top-level requestId, got ${JSON.stringify(item)}`,
        )
      }
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor ?? undefined
      pages += 1
      assert.ok(pages <= 4, 'list_pending pagination must terminate')
    } while (cursor)

    // The REST requester list shares the item shape: every item carries the
    // same top-level requestId handle get_decision and cancel take.
    const restRes = await listApprovals(
      new Request('https://hitly.example/api/v1/approvals?status=pending', {
        headers: { authorization: `Bearer ${rawKey}` },
      }),
    )
    const restBody = (await restRes.json()) as { items: Array<{ id: string; requestId?: string }> }
    assert.ok(Array.isArray(restBody.items) && restBody.items.length > 0, 'REST pending list must be non-empty')
    for (const item of restBody.items) {
      assert.equal(
        item.requestId,
        item.id,
        `every REST pending item must carry a top-level requestId, got ${JSON.stringify(item)}`,
      )
    }

    assert.ok(
      hostCalls.some((call) => call.includes('GET ') && call.includes('/api/v1/approvals') && call.includes('status=pending')),
      `list_pending must hit GET /api/v1/approvals?status=pending, got ${hostCalls.join(' | ')}`,
    )
    assert.equal(seen.length, total)
    assert.equal(seen[0], newestId)
    assert.equal(seen[total - 1], oldestId, 'item 101 must be reachable via list_pending + nextCursor on the real host')
  } finally {
    await h.close()
  }
})
