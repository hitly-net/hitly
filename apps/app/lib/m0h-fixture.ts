/**
 * Shared fixture for the M0h (PR hitly#106) real-Postgres tests: one
 * workspace + reviewer + http project + project API key, plus a capturing
 * localhost receiver. Not a test file (no *.test.ts suffix): imported by the
 * m0h-*.test.ts suites.
 */
import * as http from 'node:http'
import { AddressInfo } from 'node:net'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { users, workspaces, memberships, projects, projectMemberships, projectApiKeys } from '@hitly/db/schema'
import { generateApiKey } from './keys'
import { newId } from './ids'
import { ingestApproval } from './approvals'

export interface CapturedHit {
  path: string
  rawBody: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

export interface CapturingReceiver {
  url: string
  port: number
  hits: CapturedHit[]
  /** 'ok' -> 200 JSON; 'fail' -> 500 with a canary body. */
  setMode(mode: 'ok' | 'fail'): void
  close(): Promise<void>
}

export interface M0hFixture {
  client: pg.Client
  db: NodePgDatabase<Record<string, unknown>> & { $client: pg.Client }
  workspaceId: string
  reviewerId: string
  projectId : string
  apiKey : string
}

export async function startCapturingReceiver(): Promise<CapturingReceiver> {
  const hits: CapturedHit[] = []
  let mode: 'ok' | 'fail' = 'ok'
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        /* keep empty */
      }
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value
      }
      hits.push({ path: req.url ?? '', rawBody: raw, body, headers })
      if (mode === 'fail') {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('canary-lifecycle-5xx-body')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"status":"success"}')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    setMode(next) {
      mode = next
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}

export async function createM0hFixture(opts: { credentials?: Record<string, unknown> } = {}): Promise<M0hFixture> {
  const connectionString = process.env.DATABASE_URL ?? ''
  if (!connectionString) throw new Error('DATABASE_URL required for M0h tests')
  const client = new pg.Client({ connectionString })
  await client.connect()
  const db = drizzle(client)

  const workspaceId = newId('wsp')
  await db.insert(workspaces).values({ id: workspaceId, name: 'M0h WS', slug: `m0h-ws-${Date.now()}-${Math.random()}` })

  const reviewerId = newId('usr')
  await db.insert(users).values({
    id: reviewerId,
    name: reviewerId,
    email: `${reviewerId}@m0h-test.hitly.invalid`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await db.insert(memberships).values({
    id: newId('mem'),
    workspaceId,
    userId: reviewerId,
    role: 'member',
    createdAt: new Date(),
  })

  const projectId = newId('prj')
  await db.insert(projects).values({
    id: projectId,
    workspaceId,
    name: 'M0h Project',
    plugin: 'http',
    credentials: opts.credentials ?? {},
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await db.insert(projectMemberships).values({
    id: newId('pmb'),
    projectId,
    workspaceId,
    userId: reviewerId,
    role: 'user',
    createdAt: new Date(),
  })

  const keyGen = generateApiKey()
  await db.insert(projectApiKeys).values({
    id: newId('key'),
    projectId,
    workspaceId,
    hashedKey: keyGen.hashed,
    prefix: keyGen.prefix,
    name: 'M0h Key',
    createdAt: new Date(),
  })

  return { client, db, workspaceId, reviewerId, projectId, apiKey: keyGen.raw }
}

export async function closeM0hFixture(fixture: M0hFixture): Promise<void> {
  await fixture.client?.end().catch(() => undefined)
}

/** Ingest one http ask through the real ingest path (API-key auth, tenant writes). */
export async function ingestHttpAsk(
  fixture: M0hFixture,
  receiverUrl: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const result = await ingestApproval({
    apiKey: fixture.apiKey,
    body: {
      resumeUrl: `${receiverUrl}/resume`,
      runId: newId('run'),
      workflowName: 'm0h-flow',
      actionName: 'm0h-refund',
      args: { amount: 42 },
      metadata: { pageId: 'p1' },
      ...body,
    },
  })
  if (!result.ok) throw new Error(`ingest failed: ${result.error}`)
  return { id: result.approval.id }
}
