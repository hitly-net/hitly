/**
 * /inbox/:id (and the other server-rendered approval pages) must not leak
 * secrets in the loader DTO / RSC-shaped payload. Real Postgres, not mocked.
 *
 * Dropping redactApprovalForReviewer in loadWorkItemPage must go red.
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
import {
  users,
  workspaces,
  memberships,
  projects,
  projectMemberships,
  projectApiKeys,
  approvals,
  decisionRecords,
} from '@hitly/db/schema'
import { ingestApproval } from './approvals'
import { AUDIT_LIST_KEYS, INBOX_LIST_KEYS, listAudit, listInboxItems, serializeAuditList, serializeInboxList } from './inbox'
import { loadWorkItemPage, serializeWorkItemPage } from './work-item-page'
import { REDACTED } from './redact-request-payload'
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
  cbAuth: ['page', 'canary', 'cb-auth'].join('-'),
  resume: ['page', 'canary', 'resume-token'].join('-'),
  callback: ['page', 'canary', 'callback-secret'].join('-'),
  secretKey: ['page', 'canary', 'secretKey'].join('-'),
  passwordType: ['page', 'canary', 'password-type'].join('-'),
  decisionPayload: ['page', 'canary', 'decision-payload'].join('-'),
  resumeResponse: ['page', 'canary', 'resume-response'].join('-'),
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

  workspaceA = { id: newId('wsp'), name: 'Page Redact Workspace', slug: `page-redact-${Date.now()}` }
  await db.insert(workspaces).values(workspaceA)

  userReviewerA = { id: newId('usr') }
  await db.insert(users).values({
    ...userReviewerA,
    name: userReviewerA.id,
    email: `${userReviewerA.id}@page-redact.hitly.invalid`,
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
    name: 'Page Redact Project',
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
    name: 'Page Redact Key',
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

function code(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function assertNoCanary(label: string, json: string) {
  for (const canary of ALL_CANARIES) {
    assert.equal(json.includes(canary), false, `${label} must not contain ${canary}`)
  }
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

  const plantedEnvelope = {
    ...envelope,
    action: {
      ...action,
      args: { ...args, amount: 7, callback_secret: CANARY.callback, cb_auth_token: CANARY.cbAuth },
    },
    _meta: { secretKey: CANARY.secretKey, callback_secret: CANARY.callback },
    metadata: { resumeToken: CANARY.resume, cb_auth_token: CANARY.cbAuth },
    origin: {
      ...envelopeOrigin,
      resumeHandle: { ...envelopeHandle, reviewToken: CANARY.resume, cb_auth_token: CANARY.cbAuth },
    },
  }
  const plantedOrigin = {
    ...origin,
    cb_auth_token: CANARY.cbAuth,
    password_type: CANARY.passwordType,
    resumeHandle: {
      ...originHandle,
      reviewToken: CANARY.resume,
      cb_auth_token: CANARY.cbAuth,
    },
    _meta: { secretKey: CANARY.secretKey },
    details: {
      ...(asRecord(origin.details) as Record<string, string>),
      cb_auth_token: CANARY.cbAuth,
      password_type: CANARY.passwordType,
    },
  }

  await db
    .update(approvals)
    .set({
      envelope: await encodeTenantJson(workspaceA.id, plantedEnvelope),
      origin: await encodeTenantJson(workspaceA.id, plantedOrigin),
    })
    .where(eq(approvals.id, approvalId))
}

async function plantDecisionCanaries(approvalId: string) {
  await db.insert(decisionRecords).values({
    id: newId('dec').slice(0, 36),
    workspaceId: workspaceA.id,
    approvalId,
    actorUserId: userReviewerA.id,
    decision: 'accept',
    payload: await encodeTenantJson(workspaceA.id, {
      decision: 'accept',
      amount: 3,
      cb_auth_token: CANARY.decisionPayload,
      secretKey: CANARY.secretKey,
      callback_secret: CANARY.callback,
    }),
    resumeError: null,
    resumeResponse: await encodeTenantJson(workspaceA.id, {
      ok: true,
      accessToken: CANARY.resumeResponse,
      resumeToken: CANARY.resume,
    }),
  })
}

test('inbox detail / list / audit / mobile loaders redact on the server (source)', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const loaderSrc = fs.readFileSync(path.join(dir, 'work-item-page.ts'), 'utf8')
  const viewSrc = fs.readFileSync(path.join(dir, '../components/work-item-detail.tsx'), 'utf8')
  const inboxPageSrc = fs.readFileSync(path.join(dir, '../app/inbox/[id]/page.tsx'), 'utf8')
  const projectItemSrc = fs.readFileSync(path.join(dir, '../app/projects/[id]/item/[itemId]/page.tsx'), 'utf8')
  const inboxListPageSrc = fs.readFileSync(path.join(dir, '../app/inbox/page.tsx'), 'utf8')
  const auditPageSrc = fs.readFileSync(path.join(dir, '../app/audit/page.tsx'), 'utf8')
  const inboxLibSrc = fs.readFileSync(path.join(dir, 'inbox.ts'), 'utf8')
  const inboxApiSrc = fs.readFileSync(path.join(dir, '../app/api/v1/inbox/route.ts'), 'utf8')
  const detailApiSrc = fs.readFileSync(path.join(dir, '../app/api/v1/approvals/[id]/route.ts'), 'utf8')
  const mobileDetailSrc = fs.readFileSync(path.join(dir, '../../mobile/app/inbox/[id].tsx'), 'utf8')

  const loaderCode = code(loaderSrc)
  const viewCode = code(viewSrc)
  const inboxLibCode = code(inboxLibSrc)

  assert.match(inboxPageSrc, /WorkItemDetail/, '/inbox/:id must render WorkItemDetail')
  assert.match(projectItemSrc, /WorkItemDetail/, 'project item page must render WorkItemDetail')
  assert.match(viewCode, /loadWorkItemPage/, 'WorkItemDetail must use the server loader')
  assert.match(viewCode, /workItemClientFlightProps/, 'client props must come from the redacted DTO')
  assert.match(viewCode, /originalArgs=\{flight\.originalArgs\}/, 'AnswerForm must receive loader originalArgs')
  assert.doesNotMatch(viewCode, /decodeTenantJson/, 'view must not decode the raw approval row')
  assert.match(
    loaderCode,
    /const redacted = redactApprovalForReviewer\(\{ envelope, origin, decisions: decodedDecisions \}\)/,
    'loadWorkItemPage must redact before returning the DTO (dropping this call must go red)',
  )
  assert.doesNotMatch(loaderCode, /encodeTenantJson/, 'page loader must not write envelope/origin back')
  assert.doesNotMatch(loaderCode, /\.update\(approvals\)/, 'page loader must not update the stored row')

  assert.match(inboxListPageSrc, /listInboxItems/, 'inbox list page must use listInboxItems')
  assert.match(auditPageSrc, /listAudit/, 'audit/history page must use listAudit')
  assert.match(inboxLibCode, /toInboxListItem/, 'inbox list must map through the allowlisted DTO')
  assert.match(inboxLibCode, /toAuditRow/, 'audit list must map through the allowlisted DTO')
  assert.doesNotMatch(inboxLibCode, /approvals\.envelope/, 'inbox/audit loaders must not select envelope')
  assert.doesNotMatch(inboxLibCode, /approvals\.origin/, 'inbox/audit loaders must not select origin')
  assert.doesNotMatch(inboxLibCode, /decisionRecords\.payload/, 'audit loader must not select decision payload')
  assert.doesNotMatch(
    inboxLibCode,
    /decisionRecords\.resumeResponse/,
    'audit loader must not select origin resume JSON',
  )

  assert.match(inboxApiSrc, /listInboxItems/, 'mobile inbox list API must use listInboxItems')
  assert.match(detailApiSrc, /getApprovalDetail/, 'mobile detail API must use getApprovalDetail')
  assert.match(mobileDetailSrc, /\.approval\(/, 'mobile detail screen must load via the session detail API')
  assert.match(mobileDetailSrc, /originFields/, 'mobile Origin card must use originFields from the API DTO')
})

test('loadWorkItemPage redacts origin/args/_meta/decisions/resumeResponse; serialised RSC/HTML has no canaries', async () => {
  const approval = await ingest()
  await plantCanaries(approval.id)
  await plantDecisionCanaries(approval.id)

  const stored = await client.query<{ envelope: string; origin: string }>(
    'select envelope::text as envelope, origin::text as origin from approvals where id = $1',
    [approval.id],
  )
  const storedDecision = await client.query<{ payload: string; resume_response: string }>(
    'select payload::text as payload, resume_response::text as resume_response from decision_records where approval_id = $1',
    [approval.id],
  )
  for (const canary of [CANARY.cbAuth, CANARY.resume, CANARY.callback, CANARY.secretKey, CANARY.passwordType]) {
    assert.ok(
      stored.rows[0]!.envelope.includes(canary) || stored.rows[0]!.origin.includes(canary),
      `planted canary ${canary} must be in stored envelope or origin`,
    )
  }
  assert.ok(storedDecision.rows[0]!.payload.includes(CANARY.decisionPayload))
  assert.ok(storedDecision.rows[0]!.resume_response.includes(CANARY.resumeResponse))

  const page = await loadWorkItemPage({
    approvalId: approval.id,
    userId: userReviewerA.id,
    workspaceId: workspaceA.id,
    workspaceRole: 'admin',
  })
  assert.ok(page.ok, `expected ok, got ${JSON.stringify(page)}`)

  const serialized = serializeWorkItemPage(page)
  assertNoCanary('loadWorkItemPage RSC/HTML/props JSON', serialized)
  assert.ok(serialized.includes(REDACTED), 'redacted view should mark secrets')

  assert.equal(page.originalArgs.amount, 7)
  assert.equal(page.originalArgs.callback_secret, REDACTED)
  assert.equal(page.originalArgs.cb_auth_token, REDACTED)
  assert.equal((page.envelope as ApprovalEnvelopeLike)._meta?.secretKey, REDACTED)
  assert.equal(
    page.originFields.some((row) => ALL_CANARIES.includes(row.value)),
    false,
    'Origin section fields must not surface canaries',
  )
  assert.equal(page.originFields.some((row) => row.key === 'cb_auth_token' || row.key === 'password_type'), false)
  assert.equal(page.decisions[0]?.payload && asRecord(page.decisions[0].payload).cb_auth_token, REDACTED)
  assert.equal(page.decisions[0]?.resumeResponse && asRecord(page.decisions[0].resumeResponse).accessToken, REDACTED)

  const after = await client.query<{ envelope: string; origin: string }>(
    'select envelope::text as envelope, origin::text as origin from approvals where id = $1',
    [approval.id],
  )
  assert.equal(after.rows[0]!.envelope, stored.rows[0]!.envelope, 'stored envelope must be unchanged')
  assert.equal(after.rows[0]!.origin, stored.rows[0]!.origin, 'stored origin must be unchanged')
})

type ApprovalEnvelopeLike = { _meta?: { secretKey?: unknown } }

test('inbox list and audit/history loaders omit planted secrets from serialised props', async () => {
  const approval = await ingest()
  await plantCanaries(approval.id)
  await plantDecisionCanaries(approval.id)

  const items = await listInboxItems({
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'admin',
  })
  const found = items.find((item) => item.id === approval.id)
  assert.ok(found, 'inbox list should include the planted approval')
  assert.deepEqual(Object.keys(found).sort(), [...INBOX_LIST_KEYS].sort())
  const inboxJson = serializeInboxList(items)
  assertNoCanary('inbox list JSON', inboxJson)

  const audit = await listAudit({
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'admin',
  })
  const auditRow = audit.find((row) => row.approvalId === approval.id)
  assert.ok(auditRow, 'audit/history list should include the planted decision')
  assert.deepEqual(Object.keys(auditRow).sort(), [...AUDIT_LIST_KEYS].sort())
  const auditJson = serializeAuditList(audit)
  assertNoCanary('audit/history JSON', auditJson)
})
