import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { and, eq, inArray } from 'drizzle-orm'
import {
  accountSecurityEvents,
  accounts,
  approvals,
  decisionRecords,
  invites,
  memberships,
  projects,
  projectMemberships,
  pushTokens,
  sessions,
  userDevices,
  users,
  workspaces,
} from '@hitly/db/schema'
import { db } from './db'
import { newId } from './ids'
import { EXPORT_SECURITY_EVENT_TYPE, handleDataExport } from './gdpr-export'

/**
 * LIVE end-to-end GDPR export test against real Postgres (same harness style
 * as lib/password-change.live.test.ts): real rows in every table the export
 * reads, the real handler, the real zip bytes parsed back and asserted.
 *
 * 1. Shape: every section file exists; the manifest carries counts, the
 *    user id and truncated:false; Content-Disposition names the dated file.
 * 2. Redaction: canary secrets (session token, OAuth tokens, password hash,
 *    raw push tokens, raw request args, envelope metadata, third-party
 *    contact, another reviewer's comment, project credentials) appear
 *    nowhere in the archive; the reviewer prompt/context and the user's own
 *    decision do appear.
 * 3. Audit: exactly one data_export account-security event is written.
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

if (!db) throw new Error('DATABASE_URL required for live export tests')
const database = db

const run = newId('t').slice(-10)
const USER_ID = newId('usr')
const OTHER_ID = newId('usr')
const WORKSPACE_ID = newId('wsp')
const PROJECT_ID = newId('prj')
const APPROVAL_ID = newId('apr')

const CANARIES = [
  'SESSION_TOKEN_CANARY',
  'CanaryOauthAcc92',
  'CanaryOauthRef93',
  'CanaryOauthId94',
  'CanaryArgonPw95',
  'FULLTOKEN',
  'RAW_ARGS_CANARY',
  'METADATA_CANARY',
  'THIRD_PARTY_CANARY',
  'EVIDENCE_CANARY',
  'OTHER_REVIEWER_CANARY',
  'EDIT_ARGS_CANARY',
  'projKeyCanary9z',
]

async function seed() {
  await database.insert(users).values({
    id: USER_ID,
    name: 'Erin Example',
    email: `erin-${run}@export-live.example.com`,
    emailVerified: true,
  })
  await database.insert(users).values({
    id: OTHER_ID,
    name: 'Other Reviewer',
    email: `other-${run}@export-live.example.com`,
    emailVerified: true,
  })
  await database.insert(sessions).values({
    id: newId('ses'),
    userId: USER_ID,
    token: `sess_tok_${run}_SESSION_TOKEN_CANARY`,
    expiresAt: new Date(Date.now() + 86_400_000),
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (LiveTest)',
  })
  await database.insert(accounts).values({
    id: newId('acc'),
    userId: USER_ID,
    providerId: 'google',
    accountId: `google-${run}`,
    accessToken: 'ya29.CanaryOauthAcc92',
    refreshToken: '1//CanaryOauthRef93',
    idToken: 'jwt.CanaryOauthId94',
    scope: 'openid email',
    password: 'argon2$CanaryArgonPw95',
  })
  await database.insert(workspaces).values({ id: WORKSPACE_ID, name: `Export ${run}`, slug: `export-${run}` })
  await database.insert(memberships).values({ id: newId('mb'), workspaceId: WORKSPACE_ID, userId: USER_ID, role: 'owner' })
  await database.insert(projects).values({
    id: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Refunds',
    plugin: 'http',
    credentials: { apiKey: 'projKeyCanary9z' },
  })
  await database.insert(projectMemberships).values({
    id: newId('pm'),
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    userId: USER_ID,
    role: 'admin',
  })
  await database.insert(userDevices).values({
    id: newId('dev'),
    userId: USER_ID,
    expoPushToken: `ExponentPushToken[FULLTOKEN_${run}_tail]`,
    platform: 'ios',
  })
  await database.insert(pushTokens).values({
    id: newId('pt'),
    userId: USER_ID,
    token: `ExponentPushToken[FULLTOKEN_${run}_tail]`,
    platform: 'android',
  })
  await database.insert(invites).values({
    id: newId('inv'),
    workspaceId: WORKSPACE_ID,
    email: `invited-${run}@export-live.example.com`,
    role: 'member',
    invitedByUserId: USER_ID,
    tokenHash: `invitetokenhash_${run}`,
    expiresAt: new Date(Date.now() + 86_400_000),
  })
  await database.insert(approvals).values({
    id: APPROVAL_ID,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    plugin: 'http',
    status: 'decided',
    actionName: 'refund.order',
    envelope: {
      action: { name: 'refund.order', args: { card: '4111111111111111', note: 'RAW_ARGS_CANARY' } },
      prompt: 'Approve the refund?',
      contextMarkdown: 'Order 42 flagged LIVE_EXPORT_OK.',
      metadata: { internal: 'METADATA_CANARY' },
      externalUrls: [{ url: 'https://corp.example/42', label: 'TICKET_THIRD_PARTY_CANARY' }],
      attachments: [{ name: 'PROOF_EVIDENCE_CANARY' }],
    },
    origin: { agentName: 'refund-agent' },
    assignedUserId: USER_ID,
    presentedByUserId: USER_ID,
  })
  await database.insert(decisionRecords).values([
    {
      id: newId('dr'),
      workspaceId: WORKSPACE_ID,
      approvalId: APPROVAL_ID,
      actorUserId: USER_ID,
      decision: 'accept',
      payload: {
        decision: 'accept',
        reason: `fine-${run}`,
        answer: 'yes',
        editedArgs: { amount: 'EDIT_ARGS_CANARY' },
      },
      client: { channel: 'device-xyz' },
    },
    {
      id: newId('dr'),
      workspaceId: WORKSPACE_ID,
      approvalId: APPROVAL_ID,
      actorUserId: OTHER_ID,
      decision: 'accept',
      payload: { decision: 'accept', reason: 'OTHER_REVIEWER_CANARY' },
    },
  ])
  await database.insert(accountSecurityEvents).values({ id: newId('ase'), userId: USER_ID, type: 'mfa_enrolled' })
}

async function cleanup() {
  await database.delete(accountSecurityEvents).where(inArray(accountSecurityEvents.userId, [USER_ID, OTHER_ID]))
  await database.delete(decisionRecords).where(eq(decisionRecords.workspaceId, WORKSPACE_ID))
  await database.delete(approvals).where(eq(approvals.workspaceId, WORKSPACE_ID))
  await database.delete(invites).where(eq(invites.workspaceId, WORKSPACE_ID))
  await database.delete(pushTokens).where(eq(pushTokens.userId, USER_ID))
  await database.delete(userDevices).where(eq(userDevices.userId, USER_ID))
  await database.delete(projectMemberships).where(eq(projectMemberships.workspaceId, WORKSPACE_ID))
  await database.delete(projects).where(eq(projects.workspaceId, WORKSPACE_ID))
  await database.delete(memberships).where(eq(memberships.workspaceId, WORKSPACE_ID))
  await database.delete(workspaces).where(eq(workspaces.id, WORKSPACE_ID))
  await database.delete(sessions).where(eq(sessions.userId, USER_ID))
  await database.delete(accounts).where(eq(accounts.userId, USER_ID))
  await database.delete(users).where(inArray(users.id, [USER_ID, OTHER_ID]))
}

function unzip(zip: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocd > 0, 'archive has an end-of-central-directory record')
  const total = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  for (let i = 0; i < total; i += 1) {
    const method = zip.readUInt16LE(p + 10)
    const cSize = zip.readUInt32LE(p + 20)
    const nameLen = zip.readUInt16LE(p + 28)
    const localOff = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const localNameLen = zip.readUInt16LE(localOff + 26)
    const body = zip.subarray(localOff + 30 + localNameLen, localOff + 30 + localNameLen + cSize)
    out.set(name, (method === 8 ? inflateRawSync(body) : Buffer.from(body)).toString('utf8'))
    p += 46 + nameLen
  }
  return out
}

describe('gdpr export live (real Postgres)', () => {
  before(async () => {
    await seed()
  })
  after(async () => {
    await cleanup()
  })

  it('exports a redacted zip end-to-end and records the audit event', async () => {
    const request = { headers: new Headers({ origin: process.env.BETTER_AUTH_URL ?? 'http://localhost:3001' }) }
    const response = await handleDataExport(request, {
      getSessionUser: async () => ({ id: USER_ID }),
      database,
      allow: () => true,
      log: () => {},
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition') ?? '', /hitly-data-export-\d{4}-\d{2}-\d{2}\.zip/)
    assert.equal(response.headers.get('x-hitly-export-truncated'), '0')

    const zip = Buffer.from(await response.arrayBuffer())
    const files = unzip(zip)
    for (const name of [
      'profile.json',
      'sessions.json',
      'accounts.json',
      'workspaces.json',
      'projects.json',
      'devices.json',
      'pushTokens.json',
      'sentInvites.json',
      'securityEvents.json',
      'approvals.json',
      'manifest.json',
    ]) {
      assert.ok(files.has(name), `${name} present in the archive`)
    }

    const all = [...files.values()].join('\n')
    for (const canary of CANARIES) {
      assert.ok(!all.includes(canary), `archive must not contain ${canary}`)
    }
    assert.ok(all.includes('Approve the refund?'), 'reviewer prompt is exported')
    assert.ok(all.includes('LIVE_EXPORT_OK'), 'reviewer context is exported')
    assert.ok(all.includes(`fine-${run}`), 'own decision reason is exported')

    const approval = JSON.parse(files.get('approvals.json')!)[0]
    assert.deepEqual(approval.roles.sort(), ['assigned', 'decided', 'presented'])
    assert.equal(approval.decisions.length, 1, 'only the user own decision record')
    assert.equal(approval.decisions[0].reason, `fine-${run}`)

    const manifest = JSON.parse(files.get('manifest.json')!)
    assert.equal(manifest.kind, 'hitly-data-export')
    assert.equal(manifest.userId, USER_ID)
    assert.equal(manifest.truncated, false)
    assert.equal(manifest.files.approvals, 1)
    assert.equal(manifest.files.sessions, 1)

    const events = await database
      .select()
      .from(accountSecurityEvents)
      .where(
        and(
          eq(accountSecurityEvents.userId, USER_ID),
          eq(accountSecurityEvents.type, EXPORT_SECURITY_EVENT_TYPE),
        ),
      )
    assert.equal(events.length, 1, 'one data_export audit row written')
  })
})
