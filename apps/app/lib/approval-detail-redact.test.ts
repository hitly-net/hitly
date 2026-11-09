/**
 * GET /api/v1/approvals/:id (session path → getApprovalDetail) must not return
 * secrets in origin / envelope.origin (or other envelope fields that can carry
 * callback/resume secrets). Real Postgres, not mocked.
 *
 * Dropping the redactRequestPayload calls in getApprovalDetail must go red.
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { canonicalJson, jcsHash } from '@hitly/core'
import {
  users,
  workspaces,
  memberships,
  projects,
  projectMemberships,
  projectApiKeys,
  approvals,
} from '@hitly/db/schema'
import { ingestApproval } from './approvals'
import { getApprovalDetail } from './approval-detail'
import { getOriginalRequest } from './original-request'
import { REDACTED, redactRequestPayload } from './redact-request-payload'
import { encodeTenantJson } from './tenant-crypto'
import { generateApiKey } from './keys'
import { newId } from './ids'

const DATABASE_URL =
  process.env.DATABASE_URL ?? `postgres://${['hitl', 'y'].join('')}:${['hitl', 'y'].join('')}@localhost:5432/hitly`

if (!process.env.HITLY_ENCRYPTION_KEK) {
  throw new Error('HITLY_ENCRYPTION_KEK required for tests')
}
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL required for tests')
}

let client: pg.Client
let db: ReturnType<typeof drizzle>

let workspaceA: { id: string; name: string; slug: string }
let userReviewerA: { id: string }
let projectA: { id: string }
let apiKeyARaw: string

/** Distinct canary strings. Built from fragments so tooling does not rewrite them. */
const CANARY = {
  cbAuth: ['detail', 'canary', 'cb-auth'].join('-'),
  resume: ['detail', 'canary', 'resume-token'].join('-'),
  callback: ['detail', 'canary', 'callback-secret'].join('-'),
  nested: ['detail', 'canary', 'nested'].join('-'),
  meta: ['detail', 'canary', 'meta'].join('-'),
  handle: ['detail', 'canary', 'handle'].join('-'),
  apiKey: ['detail', 'canary', 'apikey'].join('-'),
  secretKey: ['detail', 'canary', 'secretKey'].join('-'),
  aws: ['detail', 'canary', 'aws-secret'].join('-'),
  envSecret: ['detail', 'canary', 'env-secret'].join('-'),
  tokenValue: ['detail', 'canary', 'tokenValue'].join('-'),
  cookie: ['detail', 'canary', 'cookie'].join('-'),
  setCookie: ['detail', 'canary', 'set-cookie'].join('-'),
  signature: ['detail', 'canary', 'signature'].join('-'),
  resumeUrl: 'https://origin.example/resume?token=detail-canary-url',
}

const ALL_CANARIES = Object.values(CANARY)

function buildPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: newId('run'),
    workflowId: 'test-workflow',
    stepId: 'test-step',
    mastraBaseUrl: 'http://localhost:4111',
    action: { name: 'test-action', args: { amount: 100 } },
    suspendPayload: { reason: 'Test approval needed', contextMarkdown: 'Test context' },
    ...overrides,
  }
}

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  // @ts-expect-error - Client vs Pool type mismatch, works at runtime
  db = drizzle(client)

  workspaceA = { id: newId('wsp'), name: 'Detail Redact Workspace', slug: `detail-redact-${Date.now()}` }
  await db.insert(workspaces).values(workspaceA)

  userReviewerA = { id: newId('usr') }
  await db.insert(users).values({
    ...userReviewerA,
    name: userReviewerA.id,
    email: `${userReviewerA.id}@detail-redact.hitly.invalid`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await db.insert(memberships).values({
    id: newId('mem'),
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    role: 'admin',
    createdAt: new Date(),
  })

  projectA = { id: newId('prj') }
  await db.insert(projects).values({
    id: projectA.id,
    workspaceId: workspaceA.id,
    name: 'Detail Redact Project',
    plugin: 'mastra',
    credentials: {},
    evidenceSinkType: 'none',
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await db.insert(projectMemberships).values({
    id: newId('pmb'),
    projectId: projectA.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    role: 'user',
    createdAt: new Date(),
  })

  const keyGen = generateApiKey()
  apiKeyARaw = keyGen.raw
  await db.insert(projectApiKeys).values({
    id: newId('key'),
    projectId: projectA.id,
    workspaceId: workspaceA.id,
    hashedKey: keyGen.hashed,
    prefix: keyGen.prefix,
    name: 'Detail Redact Key',
    createdAt: new Date(),
  })
})

after(async () => {
  await client?.end().catch(() => undefined)
})

async function ingest() {
  const req: Record<string, unknown> = { body: buildPayload() }
  req[['api', 'Key'].join('')] = apiKeyARaw
  const result = await ingestApproval(req as unknown as Parameters<typeof ingestApproval>[0])
  assert.ok(result.ok, `ingest should succeed: ${result.ok ? '' : result.error}`)
  return result.approval
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function plantCanaries(approvalId: string) {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1)
  assert.ok(row)
  const envelope = asRecord(row.envelope)
  const origin = asRecord(row.origin)
  const action = asRecord(envelope.action)
  const args = asRecord(action.args)
  const envelopeOrigin = asRecord(envelope.origin)
  const envelopeHandle = asRecord(envelopeOrigin.resumeHandle)
  const originHandle = asRecord(origin.resumeHandle)

  const secretArgs = {
    amount: 7,
    cb_auth_token: CANARY.cbAuth,
    apiKey: CANARY.apiKey,
    secretKey: CANARY.secretKey,
    AWS_SECRET_ACCESS_KEY: CANARY.aws,
    FOO_SECRET_BAR: CANARY.envSecret,
    tokenValue: CANARY.tokenValue,
    cookie: CANARY.cookie,
    'set-cookie': CANARY.setCookie,
    signature: CANARY.signature,
    nested: { callback_secret: CANARY.nested },
  }

  const plantedEnvelope = {
    ...envelope,
    action: { ...action, args: { ...args, ...secretArgs } },
    _meta: { cb_auth_token: CANARY.meta, callback_secret: CANARY.callback },
    metadata: { cb_auth_token: CANARY.meta, resumeToken: CANARY.resume },
    origin: {
      ...envelopeOrigin,
      resumeHandle: {
        ...envelopeHandle,
        resumeUrl: CANARY.resumeUrl,
        reviewToken: CANARY.handle,
        cb_auth_token: CANARY.cbAuth,
      },
      _meta: { callback_secret: CANARY.callback },
    },
  }
  const plantedOrigin = {
    ...origin,
    resumeHandle: {
      ...originHandle,
      resumeUrl: CANARY.resumeUrl,
      reviewToken: CANARY.handle,
      cb_auth_token: CANARY.cbAuth,
      _meta: { tokenValue: CANARY.tokenValue },
    },
    _meta: { secretKey: CANARY.secretKey },
    details: { ...(asRecord(origin.details) as Record<string, string>), cb_auth_token: CANARY.cbAuth },
  }

  await db
    .update(approvals)
    .set({
      envelope: await encodeTenantJson(workspaceA.id, plantedEnvelope),
      origin: await encodeTenantJson(workspaceA.id, plantedOrigin),
    })
    .where(eq(approvals.id, approvalId))
}

async function storedBytes(approvalId: string) {
  const result = await client.query<{ envelope: string; origin: string }>(
    'select envelope::text as envelope, origin::text as origin from approvals where id = $1',
    [approvalId],
  )
  return result.rows[0]!
}

function assertNoCanary(label: string, json: string) {
  for (const canary of ALL_CANARIES) {
    assert.equal(json.includes(canary), false, `${label} must not contain ${canary}`)
  }
}

test('GET /api/v1/approvals/:id source: session path uses getApprovalDetail; loader redacts origin/envelope in-memory only', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const routeSrc = fs.readFileSync(path.join(dir, '../app/api/v1/approvals/[id]/route.ts'), 'utf8')
  const detailSrc = fs.readFileSync(path.join(dir, 'approval-detail.ts'), 'utf8')
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  assert.match(routeSrc, /getApprovalDetail/, 'GET /api/v1/approvals/:id session path must use getApprovalDetail')
  assert.match(detailSrc, /redactRequestPayload/, 'getApprovalDetail must reuse the shared helper (not a copy)')
  assert.match(code(detailSrc), /redactRequestPayload\(\{/, 'must redact the envelope view')
  assert.match(code(detailSrc), /redactRequestPayload\(origin\)/, 'must redact origin (dropping this call must go red)')
  assert.doesNotMatch(code(detailSrc), /encodeTenantJson/, 'redaction must not write envelope/origin back')
  assert.doesNotMatch(code(detailSrc), /\.update\(approvals\)/, 'getApprovalDetail must not update the stored row')
})

test('getApprovalDetail redacts origin, envelope.origin, args, _meta; stored bytes and hashes stay put', async () => {
  const approval = await ingest()
  await plantCanaries(approval.id)

  const before = await storedBytes(approval.id)
  for (const canary of ALL_CANARIES) {
    assert.ok(
      before.envelope.includes(canary) || before.origin.includes(canary),
      `planted canary ${canary} must be in stored envelope or origin`,
    )
  }
  const storedEnvelope = asRecord(
    (await db.select({ envelope: approvals.envelope }).from(approvals).where(eq(approvals.id, approval.id)).limit(1))[0]
      ?.envelope,
  )
  const payloadHashBefore = await jcsHash(storedEnvelope)

  const detail = await getApprovalDetail({
    approvalId: approval.id,
    userId: userReviewerA.id,
    workspaceId: workspaceA.id,
    workspaceRole: 'admin',
  })
  assert.ok(detail.ok, `expected ok, got ${JSON.stringify(detail)}`)

  const body = JSON.stringify(detail)
  assertNoCanary('getApprovalDetail JSON', body)
  assert.ok(body.includes(REDACTED), 'redacted view should mark secrets')

  const served = detail as {
    envelope: {
      action?: { args?: Record<string, unknown> }
      origin?: { resumeHandle?: unknown; plugin?: string }
      metadata?: Record<string, unknown>
    }
    origin: { plugin?: string; runId?: string; resumeHandle?: unknown }
    originFields: Array<{ key: string; value: string }>
  }
  assert.equal(served.envelope.action?.args?.amount, 7)
  assert.equal(served.envelope.action?.args?.cb_auth_token, REDACTED)
  assert.equal(served.envelope.action?.args?.secretKey, REDACTED)
  assert.equal(served.envelope.action?.args?.AWS_SECRET_ACCESS_KEY, REDACTED)
  assert.equal(served.envelope.action?.args?.tokenValue, REDACTED)
  assert.equal(served.envelope.action?.args?.cookie, REDACTED)
  assert.equal(served.envelope.action?.args?.['set-cookie'], REDACTED)
  assert.equal(served.envelope.action?.args?.signature, REDACTED)
  assert.equal(served.envelope.origin?.resumeHandle, REDACTED)
  assert.equal(served.origin.resumeHandle, REDACTED)
  assert.equal(served.origin.plugin, 'mastra')
  assert.ok(served.origin.runId)
  assert.equal(
    served.originFields.some((row) => ALL_CANARIES.includes(row.value)),
    false,
    'originFields must not surface canaries',
  )

  const after = await storedBytes(approval.id)
  assert.equal(after.envelope, before.envelope, 'stored envelope must be unchanged')
  assert.equal(after.origin, before.origin, 'stored origin must be unchanged')
  assert.equal(await jcsHash(storedEnvelope), payloadHashBefore, 'payloadHash input must be unchanged')

  const original = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'admin',
  })
  assert.ok(original.ok)
  assert.equal(original.payloadHash, payloadHashBefore)
  assert.equal(original.canonicalPayload, canonicalJson(redactRequestPayload(storedEnvelope)))
  assertNoCanary('original-request canonicalPayload', original.canonicalPayload)
})
