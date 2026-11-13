import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
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
import {
  buildExportFiles,
  handleDataExport,
  projectApprovalForExport,
  EXPORT_TABLE_ROW_LIMIT,
} from './gdpr-export'
import { createExportLimiter, EXPORT_RETRY_AFTER_SECONDS } from './gdpr-export-limit'
import { createZip } from './zip'

/**
 * Unit tests for the GDPR export builder: field allow-lists, redaction
 * canaries, size/truncation caps, and the once-per-hour limiter. A hand-rolled
 * fake database answers every select by table, so no Postgres is needed; the
 * live end-to-end run against real Postgres is lib/gdpr-export.live.test.ts.
 *
 * Mutation notes (each mutant turns one test RED):
 * - Widen the approvals allow-list (e.g. pass envelope.action.args, metadata,
 *   externalUrls, or another reviewer's decision payload) -> the canary test
 *   fails on RAW_ARGS_CANARY / METADATA_CANARY / THIRD_PARTY_CANARY /
 *   OTHER_REVIEWER_CANARY.
 * - Include a secret column (sessions.token, accounts.password /
 *   accessToken / refreshToken / idToken, a raw push token) -> SECRET_LEAK
 *   canaries fail.
 * - Drop the +1 headroom in the row caps (cap() at exactly the limit without
 *   the limit+1 fetch) -> the truncation test reports truncated:false.
 * - Return the limiter response before the session check -> the 401 test
 *   sees 429.
 */

type Row = Record<string, unknown>

const USER_ID = 'usr_export_owner'
const OTHER_USER = 'usr_other_reviewer'

function rowsByTable(): Map<unknown, Row[]> {
  const data = new Map<unknown, Row[]>()
  const put = (table: unknown, rows: Row[]) => data.set(table, rows)

  put(users, [
    {
      id: USER_ID,
      name: 'Erin Example',
      email: 'erin@example.com',
      emailVerified: true,
      image: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-02-01T00:00:00Z'),
    },
  ])
  put(sessions, [
    {
      id: 'ses_1',
      userId: USER_ID,
      token: 'sess-tok-CanarySessTok91',
      expiresAt: new Date('2026-12-01T00:00:00Z'),
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Test)',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      updatedAt: new Date('2026-02-01T00:00:00Z'),
    },
  ])
  put(accounts, [
    {
      id: 'acc_1',
      userId: USER_ID,
      accountId: 'google-123',
      providerId: 'google',
      accessToken: 'ya29.CanaryOauthAcc92',
      refreshToken: '1//CanaryOauthRef93',
      idToken: 'jwt.CanaryOauthId94',
      scope: 'openid email',
      password: 'argon2$CanaryArgonPw95',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
  ])
  put(memberships, [
    { workspaceId: 'wsp_1', name: 'Acme', slug: 'acme', role: 'owner', memberSince: new Date('2026-01-01T00:00:00Z') },
  ])
  put(workspaces, [])
  put(projectMemberships, [
    {
      projectId: 'prj_1',
      workspaceId: 'wsp_1',
      name: 'Refunds',
      plugin: 'http',
      status: 'live',
      role: 'admin',
      memberSince: new Date('2026-01-02T00:00:00Z'),
    },
  ])
  put(projects, [])
  put(userDevices, [
    {
      id: 'dev_1',
      userId: USER_ID,
      expoPushToken: 'ExponentPUSH-dev-tail01234567abcdefghij',
      platform: 'ios',
      createdAt: new Date('2026-01-03T00:00:00Z'),
      updatedAt: new Date('2026-01-03T00:00:00Z'),
    },
  ])
  put(pushTokens, [
    {
      id: 'tok_1',
      userId: USER_ID,
      token: 'ExponentPUSH-dev-tail01234567abcdefghij',
      platform: 'android',
      createdAt: new Date('2026-01-03T00:00:00Z'),
      lastSeenAt: new Date('2026-02-01T00:00:00Z'),
    },
  ])
  put(invites, [
    {
      id: 'inv_1',
      workspaceId: 'wsp_1',
      email: 'invited@example.com',
      role: 'member',
      invitedByUserId: USER_ID,
      tokenHash: 'invitehash0123456789abcdefhash0123456789abcdef',
      acceptedAt: null,
      expiresAt: new Date('2026-03-01T00:00:00Z'),
      createdAt: new Date('2026-02-01T00:00:00Z'),
    },
  ])
  put(accountSecurityEvents, [
    { id: 'ase_1', userId: USER_ID, type: 'mfa_enrolled', createdAt: new Date('2026-01-05T00:00:00Z') },
  ])
  put(approvals, [
    {
      id: 'apr_1',
      workspaceId: 'wsp_1',
      projectId: 'prj_1',
      plugin: 'http',
      status: 'decided',
      actionName: 'refund.order',
      // Tenant-stored envelope: only prompt/contextMarkdown may be exported.
      envelope: {
        action: { name: 'refund.order', args: { card: '4111111111111111', note: 'RAW_ARGS_CANARY' } },
        prompt: 'Approve the refund?',
        contextMarkdown: 'Order 42 was flagged for a refund.',
        metadata: { internal: 'METADATA_CANARY' },
        externalUrls: [{ url: 'https://corp.example/tickets/42', label: 'TICKET_THIRD_PARTY_CANARY' }],
        attachments: [{ name: 'PROOF_EVIDENCE_CANARY' }],
      },
      origin: { agentName: 'ORIGIN_AGENT_CANARY' },
      assignedUserId: USER_ID,
      presentedByUserId: OTHER_USER,
      requesterKeyId: 'key_1',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      presentedAt: new Date('2026-02-01T00:05:00Z'),
      expiresAt: new Date('2026-02-02T00:00:00Z'),
      updatedAt: new Date('2026-02-01T00:10:00Z'),
    },
  ])
  put(decisionRecords, [
    {
      id: 'drc_1',
      workspaceId: 'wsp_1',
      approvalId: 'apr_1',
      actorUserId: USER_ID,
      decision: 'accept',
      // Own decision record: decision/reason/answer only; editedArgs excluded.
      payload: { decision: 'accept', reason: 'looks fine', answer: 'yes', editedArgs: { amount: 'EDIT_ARGS_CANARY' } },
      client: { channel: 'REVIEWER_CLIENT_CANARY' },
      createdAt: new Date('2026-02-01T00:10:00Z'),
    },
    {
      id: 'drc_2',
      workspaceId: 'wsp_1',
      approvalId: 'apr_2',
      actorUserId: OTHER_USER,
      decision: 'reject',
      payload: { decision: 'reject', reason: 'OTHER_REVIEWER_CANARY' },
      createdAt: new Date('2026-02-01T00:11:00Z'),
    },
  ])
  return data
}

type FakeDb = {
  select: () => {
    from: (table: unknown) => {
      innerJoin: () => ReturnType<FakeDb['select']> extends { from: (...a: never[]) => infer R } ? R : never
      where: () => unknown
      orderBy: () => unknown
      limit: (n: number) => Promise<Row[]>
    }
  }
  insert: (table: unknown) => { values: (row: Row) => Promise<void> }
}

function fakeDatabase(data: Map<unknown, Row[]>): { db: FakeDb; inserts: Array<{ table: unknown; row: Row }> } {
  const inserts: Array<{ table: unknown; row: Row }> = []
  const chain = (table: unknown): unknown => {
    const self = {
      innerJoin: () => self,
      where: () => self,
      orderBy: () => self,
      limit: async (n: number) => (data.get(table) ?? []).slice(0, n),
    }
    return self
  }
  return {
    db: {
      select: () => ({ from: (table: unknown) => chain(table) }) as never,
      insert: (table: unknown) => ({
        values: async (row: Row) => {
          inserts.push({ table, row })
        },
      }),
    },
    inserts,
  }
}

function unzip(zip: Buffer): Map<string, string> {
  // Minimal reader: central directory only; entries here are deflate or store.
  const out = new Map<string, string>()
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
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

describe('gdpr export builder (fake db)', () => {
  it('exports the allow-listed fields and leaks none of the canaries', async () => {
    const { db } = fakeDatabase(rowsByTable())
    const built = await buildExportFiles(db as never, USER_ID)
    const files = unzip(createZip(built.entries))
    const all = [...files.values()].join('\n')

    // Nothing secret or out-of-scope may appear anywhere in the archive.
    for (const canary of [
      'CanarySessTok91',
      'CanaryOauthAcc92',
      'CanaryOauthRef93',
      'CanaryOauthId94',
      'CanaryArgonPw95',
      'hashedKey',
      '4567abcdefghij',
      'RAW_ARGS_CANARY',
      'METADATA_CANARY',
      'THIRD_PARTY_CANARY',
      'EVIDENCE_CANARY',
      'ORIGIN_AGENT_CANARY',
      'OTHER_REVIEWER_CANARY',
      'EDIT_ARGS_CANARY',
      'REVIEWER_CLIENT_CANARY',
      'tokenHash',
    ]) {
      assert.ok(!all.includes(canary), `archive must not contain ${canary}`)
    }

    const profile = JSON.parse(files.get('profile.json')!)
    assert.equal(profile.email, 'erin@example.com')

    const session = JSON.parse(files.get('sessions.json')!)[0]
    assert.equal(session.userAgent, 'Mozilla/5.0 (Test)')
    assert.ok(!('token' in session))

    const account = JSON.parse(files.get('accounts.json')!)[0]
    assert.equal(account.providerId, 'google')
    assert.equal(account.hasPassword, true)

    const approval = JSON.parse(files.get('approvals.json')!)[0]
    assert.equal(approval.title, 'refund.order')
    assert.equal(approval.prompt, 'Approve the refund?')
    assert.equal(approval.contextMarkdown, 'Order 42 was flagged for a refund.')
    assert.deepEqual(approval.roles, ['assigned', 'decided'])
    assert.deepEqual(approval.decisions, [
      { decision: 'accept', reason: 'looks fine', answer: 'yes', createdAt: '2026-02-01T00:10:00.000Z' },
    ])

    const devices = JSON.parse(files.get('devices.json')!)
    assert.equal(devices[0].tokenPrefix, 'ExponentPUSH')
    const push = JSON.parse(files.get('pushTokens.json')!)
    assert.equal(push[0].tokenPrefix, 'ExponentPUSH')

    const invitesFile = JSON.parse(files.get('sentInvites.json')!)
    assert.equal(invitesFile[0].email, 'invited@example.com')

    const manifest = JSON.parse(files.get('manifest.json')!)
    assert.equal(manifest.kind, 'hitly-data-export')
    assert.equal(manifest.truncated, false)
    assert.equal(manifest.files.approvals, 1)
  })

  it('marks the manifest truncated when a table exceeds the row cap', async () => {
    const data = rowsByTable()
    data.set(
      sessions,
      Array.from({ length: EXPORT_TABLE_ROW_LIMIT + 1 }, (_, i) => ({
        id: `ses_${i}`,
        userId: USER_ID,
        token: `sess_tok_${i}`,
        expiresAt: new Date(),
        ipAddress: null,
        userAgent: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    )
    const { db } = fakeDatabase(data)
    const built = await buildExportFiles(db as never, USER_ID)
    assert.equal(built.truncated, true)
    const files = unzip(createZip(built.entries))
    const manifest = JSON.parse(files.get('manifest.json')!)
    assert.equal(manifest.truncated, true)
    assert.equal(manifest.files.sessions, EXPORT_TABLE_ROW_LIMIT)
  })

  it('projectApprovalForExport keeps exactly the allowed keys', () => {
    const projected = projectApprovalForExport(
      {
        id: 'apr_1',
        workspaceId: 'wsp_1',
        projectId: 'prj_1',
        plugin: 'http',
        status: 'decided',
        actionName: 'x',
        createdAt: new Date(0),
        presentedAt: null,
        expiresAt: null,
        updatedAt: null,
      },
      { prompt: 'p', contextMarkdown: 'c', action: { args: { secret: 'no' } }, metadata: { secret: 'no' } },
      ['assigned', 'decided'],
      [{ decision: 'accept', payload: { reason: 'r', answer: 1, editedArgs: { a: 1 } }, createdAt: new Date(0) }],
    )
    assert.deepEqual(Object.keys(projected).sort(), [
      'contextMarkdown',
      'createdAt',
      'decisions',
      'expiresAt',
      'id',
      'plugin',
      'presentedAt',
      'projectId',
      'prompt',
      'roles',
      'status',
      'title',
      'updatedAt',
      'workspaceId',
    ])
    const decisions = projected.decisions as Array<Record<string, unknown>>
    assert.deepEqual(Object.keys(decisions[0] ?? {}).sort(), ['answer', 'createdAt', 'decision', 'reason'])
  })
})

describe('gdpr export handler (fake db)', () => {
  function requestWith() {
    return { headers: new Headers({ cookie: 'better-auth.session_token=***' }) }
  }

  it('returns the zip with attachment headers and records a data_export event', async () => {
    const { db, inserts } = fakeDatabase(rowsByTable())
    const res = await handleDataExport(requestWith(), {
      getSessionUser: async () => ({ id: USER_ID }),
      database: db as never,
      allow: () => true,
      log: () => {},
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/zip')
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="hitly-data-export-\d{4}-\d{2}-\d{2}\.zip"$/)
    assert.equal(res.headers.get('x-hitly-export-truncated'), '0')
    assert.equal(inserts.length, 1)
    assert.equal(inserts[0].table, accountSecurityEvents)
    assert.equal((inserts[0].row as Row).type, 'data_export')
    assert.equal((inserts[0].row as Row).userId, USER_ID)
  })

  it('401 without a session and never consults the limiter first', async () => {
    const { db } = fakeDatabase(rowsByTable())
    let limiterTouched = false
    const res = await handleDataExport(requestWith(), {
      getSessionUser: async () => null,
      database: db as never,
      allow: () => {
        limiterTouched = true
        return true
      },
      log: () => {},
    })
    assert.equal(res.status, 401)
    assert.equal(limiterTouched, false)
  })

  it('429 with Retry-After when the per-user limiter is exhausted', async () => {
    const { db } = fakeDatabase(rowsByTable())
    const res = await handleDataExport(requestWith(), {
      getSessionUser: async () => ({ id: USER_ID }),
      database: db as never,
      allow: () => false,
      log: () => {},
    })
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('retry-after'), String(EXPORT_RETRY_AFTER_SECONDS))
    const body = await res.json()
    assert.deepEqual(body, { error: 'too_many_requests' })
  })

  it('the shared limiter allows exactly one export per window per user', () => {
    let nowMs = 1_700_000_000_000
    const limiter = createExportLimiter({ now: () => nowMs })
    assert.equal(limiter(USER_ID), true)
    assert.equal(limiter(USER_ID), false)
    assert.equal(limiter('usr_other'), true, 'another user has their own bucket')
    nowMs += 60 * 60 * 1000
    assert.equal(limiter(USER_ID), true)
  })

  it('500 when the database is not configured', async () => {
    const res = await handleDataExport(requestWith(), {
      getSessionUser: async () => ({ id: USER_ID }),
      database: undefined,
      allow: () => true,
      log: () => {},
    })
    assert.equal(res.status, 500)
  })
})
