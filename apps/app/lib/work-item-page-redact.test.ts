/**
 * /inbox/:id (and the other server-rendered approval pages) must not leak
 * secrets in the loader DTO / RSC-shaped payload. Real Postgres, not mocked.
 *
 * Also covers mobile session GET /api/v1/approvals/:id: planted canaries must
 * not appear raw. Passing the raw approval through that path must go red.
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
import { ingestApproval, getApprovalForOrigin } from './approvals'
import { getApprovalDetail } from './approval-detail'
import { createApprovalDetailGet } from './approval-detail-route'
import { AUDIT_LIST_KEYS, INBOX_LIST_KEYS, listAudit, listInboxItems, serializeAuditList, serializeInboxList } from './inbox'
import { loadWorkItemPage, serializeWorkItemPage } from './work-item-page'
import { REDACTED } from './redact-request-payload'
import type { ApiWorkspaceOk } from './api-session'
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
  secretCount: ['page', 'canary', 'secret-count'].join('-'),
  apiKeyRequired: ['page', 'canary', 'apikey-required'].join('-'),
  authTokenType: ['page', 'canary', 'auth-token-type'].join('-'),
  accessTokenType: ['page', 'canary', 'access-token-type'].join('-'),
  clientSecretType: ['page', 'canary', 'client-secret-type'].join('-'),
  cookieRequired: ['page', 'canary', 'cookie-required'].join('-'),
  decisionPayload: ['page', 'canary', 'decision-payload'].join('-'),
  resumeResponse: ['page', 'canary', 'resume-response'].join('-'),
}

/** False-positive keys from the #115 matcher: must stay visible (not redacted). */
const VISIBLE = {
  secretly: ['page', 'visible', 'secretly'].join('-'),
  tokenType: 'Bearer',
  tokenCount: 9,
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

  const m1Args = {
    amount: 7,
    tokenCount: VISIBLE.tokenCount,
    signatureRequired: true,
    tokenType: VISIBLE.tokenType,
    secretly: VISIBLE.secretly,
    callback_secret: CANARY.callback,
    cb_auth_token: CANARY.cbAuth,
    password_type: CANARY.passwordType,
    secret_count: CANARY.secretCount,
    apiKey_required: CANARY.apiKeyRequired,
    authTokenType: CANARY.authTokenType,
    access_token_type: CANARY.accessTokenType,
    clientSecretType: CANARY.clientSecretType,
    cookie_required: CANARY.cookieRequired,
  }
  const plantedEnvelope = {
    ...envelope,
    action: {
      ...action,
      args: { ...args, ...m1Args },
    },
    _meta: {
      secretKey: CANARY.secretKey,
      callback_secret: CANARY.callback,
      secret_count: CANARY.secretCount,
      cookie_required: CANARY.cookieRequired,
    },
    metadata: { resumeToken: CANARY.resume, cb_auth_token: CANARY.cbAuth, authTokenType: CANARY.authTokenType },
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
    _meta: { secretKey: CANARY.secretKey, apiKey_required: CANARY.apiKeyRequired },
    details: {
      ...(asRecord(origin.details) as Record<string, string>),
      cb_auth_token: CANARY.cbAuth,
      password_type: CANARY.passwordType,
      secret_count: CANARY.secretCount,
      apiKey_required: CANARY.apiKeyRequired,
      authTokenType: CANARY.authTokenType,
      access_token_type: CANARY.accessTokenType,
      clientSecretType: CANARY.clientSecretType,
      cookie_required: CANARY.cookieRequired,
      secretly: VISIBLE.secretly,
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
      tokenCount: VISIBLE.tokenCount,
      secretly: VISIBLE.secretly,
      cb_auth_token: CANARY.decisionPayload,
      secretKey: CANARY.secretKey,
      callback_secret: CANARY.callback,
      password_type: CANARY.passwordType,
      secret_count: CANARY.secretCount,
      apiKey_required: CANARY.apiKeyRequired,
      authTokenType: CANARY.authTokenType,
      access_token_type: CANARY.accessTokenType,
      cookie_required: CANARY.cookieRequired,
    }),
    resumeError: null,
    resumeResponse: await encodeTenantJson(workspaceA.id, {
      ok: true,
      tokenType: VISIBLE.tokenType,
      accessToken: CANARY.resumeResponse,
      resumeToken: CANARY.resume,
      clientSecretType: CANARY.clientSecretType,
      cookie_required: CANARY.cookieRequired,
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
  const detailRouteFactorySrc = fs.readFileSync(path.join(dir, 'approval-detail-route.ts'), 'utf8')

  const loaderCode = code(loaderSrc)
  const viewCode = code(viewSrc)
  const inboxLibCode = code(inboxLibSrc)
  const detailRouteFactoryCode = code(detailRouteFactorySrc)

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

  assert.match(inboxListPageSrc, /listInboxItemsForWeb/, 'inbox list page must page through listInboxItemsForWeb')
  assert.match(auditPageSrc, /listAudit/, 'audit/history page must use listAudit')
  assert.match(inboxLibCode, /toInboxListItem/, 'inbox list must map through the allowlisted DTO')
  assert.match(inboxLibCode, /toAuditRow/, 'audit list must map through the allowlisted DTO')
  // The envelope may be selected ONLY to project the allowlisted ask_user
  // headline (the `prompt` key); the runtime canary test below proves no
  // other envelope content ever reaches the serialised row.
  assert.match(
    inboxLibCode,
    /if \(row\.actionName === 'ask_user'\)[\s\S]*?typeof envelope\.prompt === 'string'[\s\S]*?toInboxListItem/,
    'envelope use in the inbox list must be confined to the allowlisted prompt extraction',
  )
  assert.doesNotMatch(
    inboxLibCode,
    /toInboxListItem\(\{[\s\S]*?envelope:/,
    'the inbox DTO must never carry the envelope',
  )
  assert.doesNotMatch(inboxLibCode, /approvals\.origin/, 'inbox/audit loaders must not select origin')
  assert.doesNotMatch(inboxLibCode, /decisionRecords\.payload/, 'audit loader must not select decision payload')
  assert.doesNotMatch(
    inboxLibCode,
    /decisionRecords\.resumeResponse/,
    'audit loader must not select origin resume JSON',
  )

  assert.match(inboxApiSrc, /listInboxItems/, 'mobile inbox list API must use listInboxItems')
  assert.doesNotMatch(
    code(inboxApiSrc),
    /return NextResponse\.json\(\{\s*items,\s*nextCursor:\s*null\s*\}\)/,
    'inbox list API must not hard-code nextCursor: null',
  )
  assert.match(detailApiSrc, /createApprovalDetailGet/, 'GET /api/v1/approvals/:id must use the injectable factory')
  assert.match(detailApiSrc, /requireApiWorkspace/, 'mobile detail API must authenticate through requireApiWorkspace')
  assert.match(detailApiSrc, /getApprovalDetail/, 'mobile detail API must wire getApprovalDetail')
  assert.match(
    detailRouteFactoryCode,
    /deps\.requireApiWorkspace/,
    'session path must authenticate through requireApiWorkspace (removing it must go red)',
  )
  assert.match(detailRouteFactoryCode, /deps\.getApprovalDetail/, 'session path must call getApprovalDetail')
  assert.match(
    detailRouteFactoryCode,
    /return NextResponse\.json\(detail\)/,
    'session path must return the getApprovalDetail body (a raw passthrough must go red)',
  )
  assert.doesNotMatch(detailRouteFactoryCode, /decodeTenantJson/, 'session path must not decode the raw approval row')
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
  const plantedInEnvelopeOrOrigin = [
    CANARY.cbAuth,
    CANARY.resume,
    CANARY.callback,
    CANARY.secretKey,
    CANARY.passwordType,
    CANARY.secretCount,
    CANARY.apiKeyRequired,
    CANARY.authTokenType,
    CANARY.accessTokenType,
    CANARY.clientSecretType,
    CANARY.cookieRequired,
  ]
  for (const canary of plantedInEnvelopeOrOrigin) {
    assert.ok(
      stored.rows[0]!.envelope.includes(canary) || stored.rows[0]!.origin.includes(canary),
      `planted canary ${canary} must be in stored envelope or origin`,
    )
  }
  assert.ok(storedDecision.rows[0]!.payload.includes(CANARY.decisionPayload))
  assert.ok(storedDecision.rows[0]!.resume_response.includes(CANARY.resumeResponse))
  assert.ok(storedDecision.rows[0]!.payload.includes(CANARY.secretCount))
  assert.ok(storedDecision.rows[0]!.resume_response.includes(CANARY.clientSecretType))

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

  const m1ArgKeys = [
    'callback_secret',
    'cb_auth_token',
    'password_type',
    'secret_count',
    'apiKey_required',
    'authTokenType',
    'access_token_type',
    'clientSecretType',
    'cookie_required',
  ] as const
  assert.equal(page.originalArgs.amount, 7)
  assert.equal(page.originalArgs.tokenCount, VISIBLE.tokenCount)
  assert.equal(page.originalArgs.signatureRequired, true)
  assert.equal(page.originalArgs.tokenType, VISIBLE.tokenType)
  assert.equal(page.originalArgs.secretly, VISIBLE.secretly)
  for (const key of m1ArgKeys) {
    assert.equal(page.originalArgs[key], REDACTED, `${key} must be redacted in originalArgs`)
  }
  assert.ok(serialized.includes(VISIBLE.secretly), 'non-secret secretly must stay visible')
  assert.ok(serialized.includes(String(VISIBLE.tokenCount)), 'non-secret tokenCount must stay visible')
  assert.equal((page.envelope as ApprovalEnvelopeLike)._meta?.secretKey, REDACTED)
  assert.equal(
    page.originFields.some((row) => ALL_CANARIES.includes(row.value)),
    false,
    'Origin section fields must not surface canaries',
  )
  const secretOriginKeys = [
    'cb_auth_token',
    'password_type',
    'secret_count',
    'apiKey_required',
    'authTokenType',
    'access_token_type',
    'clientSecretType',
    'cookie_required',
  ]
  assert.equal(
    page.originFields.some((row) => secretOriginKeys.includes(row.key)),
    false,
    'Origin section must drop #115 M1 secret-like keys',
  )
  assert.equal(
    page.originFields.some((row) => row.key === 'secretly' && row.value === VISIBLE.secretly),
    true,
    'Origin section must keep non-secret secretly',
  )
  assert.equal(page.originFields.some((row) => row.key === 'runId'), true, 'Origin section must keep runId')
  const decisionPayload = asRecord(page.decisions[0]?.payload)
  const resumeResponse = asRecord(page.decisions[0]?.resumeResponse)
  assert.equal(decisionPayload.cb_auth_token, REDACTED)
  assert.equal(decisionPayload.secret_count, REDACTED)
  assert.equal(decisionPayload.secretly, VISIBLE.secretly)
  assert.equal(decisionPayload.tokenCount, VISIBLE.tokenCount)
  assert.equal(resumeResponse.accessToken, REDACTED)
  assert.equal(resumeResponse.clientSecretType, REDACTED)
  assert.equal(resumeResponse.tokenType, VISIBLE.tokenType)

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
  // An ask_user-shaped row too: its envelope is projected for the allowlisted
  // `prompt` headline, so a leaky projection must trip the canaries below.
  const ask = await ingest()
  await db.update(approvals).set({ actionName: 'ask_user' }).where(eq(approvals.id, ask.id))
  await plantCanaries(ask.id)

  const { items } = await listInboxItems({
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'admin',
  })
  const found = items.find((item) => item.id === approval.id)
  assert.ok(found, 'inbox list should include the planted approval')
  assert.deepEqual(Object.keys(found).sort(), [...INBOX_LIST_KEYS].sort())
  const askRow = items.find((item) => item.id === ask.id)
  assert.ok(askRow, 'inbox list should include the planted ask_user row')
  assert.equal(askRow?.kind, 'question', 'ask_user rows are typed as questions for the ask_user tag')
  assert.deepEqual(Object.keys(askRow ?? {}).sort(), [...INBOX_LIST_KEYS].sort())
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

function sessionWorkspaceCtx(): ApiWorkspaceOk {
  return {
    ok: true,
    session: {
      user: {
        id: userReviewerA.id,
        name: userReviewerA.id,
        email: `${userReviewerA.id}@page-redact.hitly.invalid`,
      },
    },
    workspaces: [{ id: workspaceA.id, name: workspaceA.name, slug: workspaceA.slug, role: 'admin' }],
    workspace: { id: workspaceA.id, name: workspaceA.name, slug: workspaceA.slug, role: 'admin' },
    role: 'admin',
  } as ApiWorkspaceOk
}

test('mobile session GET /api/v1/approvals/:id has no raw canaries (passthrough must go red)', async () => {
  const approval = await ingest()
  await plantCanaries(approval.id)
  await plantDecisionCanaries(approval.id)

  // Mobile sends Bearer session + workspace header. Bearer is not a project key, so
  // getApprovalForOrigin 401s and the handler falls through to getApprovalDetail.
  const GET = createApprovalDetailGet({
    getApprovalForOrigin,
    getApprovalDetail,
    requireApiWorkspace: async () => sessionWorkspaceCtx(),
  })
  const response = await GET(
    new Request(`http://hitly.invalid/api/v1/approvals/${approval.id}`, {
      headers: {
        authorization: 'Bearer session-not-a-project-key',
        'x-hitly-workspace-id': workspaceA.id,
        'x-hitly-client': 'hitly-mobile/test (ios)',
      },
    }),
    { params: Promise.resolve({ id: approval.id }) },
  )
  assert.equal(response.status, 200)
  const body = await response.text()
  assertNoCanary('mobile session GET JSON', body)

  const json = JSON.parse(body) as {
    ok: boolean
    envelope?: { action?: { args?: Record<string, unknown> }; _meta?: { secretKey?: unknown } }
    originFields?: Array<{ key: string; value: string }>
    decisions?: Array<{ payload?: unknown; resumeResponse?: unknown }>
  }
  assert.equal(json.ok, true)
  const args = json.envelope?.action?.args ?? {}
  assert.equal(args.amount, 7)
  assert.equal(args.tokenCount, VISIBLE.tokenCount)
  assert.equal(args.signatureRequired, true)
  assert.equal(args.tokenType, VISIBLE.tokenType)
  assert.equal(args.secretly, VISIBLE.secretly)
  assert.equal(args.callback_secret, REDACTED)
  assert.equal(args.secret_count, REDACTED)
  assert.equal(args.apiKey_required, REDACTED)
  assert.equal(args.authTokenType, REDACTED)
  assert.equal(args.access_token_type, REDACTED)
  assert.equal(args.clientSecretType, REDACTED)
  assert.equal(args.cookie_required, REDACTED)
  assert.equal(args.password_type, REDACTED)
  assert.equal(json.envelope?._meta?.secretKey, REDACTED)
  assert.equal(
    (json.originFields ?? []).some((row) => ALL_CANARIES.includes(row.value)),
    false,
    'mobile originFields must not surface canaries',
  )
  assert.equal(asRecord(json.decisions?.[0]?.payload).secret_count, REDACTED)
  assert.equal(asRecord(json.decisions?.[0]?.payload).secretly, VISIBLE.secretly)
  assert.equal(asRecord(json.decisions?.[0]?.resumeResponse).accessToken, REDACTED)
  assert.equal(asRecord(json.decisions?.[0]?.resumeResponse).tokenType, VISIBLE.tokenType)
})
