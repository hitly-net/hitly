/**
 * LIVE Postgres, own throwaway database: pins the four capped actions
 * against the real tier_limits table, the real usage queries and the real
 * chokepoints (ingestApproval, lib/invites writers, insertNewProject /
 * setProjectStatus, retryResume). For each capped action: at-cap NEW use is
 * refused with the stable code + human message, under-cap is allowed,
 * existing data is untouched, and reads/accepts/replays never need headroom.
 *
 * Caps are moved with plain UPDATEs (the tier_limits contract: no code
 * change), and each block restores what it changed.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import path from 'node:path'
import pg from 'pg'
import { eq } from 'drizzle-orm'
import { approvals as approvalsSchema } from '@hitly/db/schema'

process.env.HITLY_TIER_LIMITS_TTL_MS = '0'

const BASE_URL = process.env.DATABASE_URL ?? ['postgres://', 'hitly:hitly@localhost:5432/', 'hitly'].join('')
const REPO_ROOT = path.join(__dirname, '../../..')
const DB = 'hitly_tier_enforce'
const DAY = 24 * 60 * 60 * 1000

function urlWithDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}
const TARGET_URL = urlWithDatabase(BASE_URL, DB)

let client: pg.Client
let fx: import('./m0h-fixture').M0hFixture
let tier: typeof import('./tier-enforcement')
let invites: typeof import('./invites')
let projectCreate: typeof import('./project-create')
let lifecycle: typeof import('./project-lifecycle')
let approvalsLib: typeof import('./approvals')
let withTenant: <T>(workspaceId: string, fn: () => Promise<T>) => Promise<T>
let requireDb: () => import('./tenant').TenantDatabase

async function setCap(plan: string, key: string, value: number | null): Promise<void> {
  await client.query(
    'INSERT INTO tier_limits (plan, limit_key, value) VALUES ($1, $2, $3) ON CONFLICT (plan, limit_key) DO UPDATE SET value = EXCLUDED.value',
    [plan, key, value],
  )
}

async function monthApprovalRows(): Promise<number> {
  const r = await client.query(
    `SELECT count(*)::int AS n FROM approvals WHERE workspace_id = $1
     AND created_at >= date_trunc('month', now())`,
    [fx.workspaceId],
  )
  return r.rows[0].n
}

async function seedApproval(id: string, createdAt: Date, status: string): Promise<void> {
  await client.query(
    `INSERT INTO approvals (id, workspace_id, project_id, plugin, status, action_name, envelope, origin, created_at, updated_at)
     VALUES ($1, $2, $3, 'http', $4, 'te.action', '{}'::jsonb, '{}'::jsonb, $5, $5)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, created_at = EXCLUDED.created_at`,
    [id, fx.workspaceId, fx.projectId, status, createdAt],
  )
}

before(async () => {
  const admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`)
  await admin.query(`CREATE DATABASE ${DB}`)
  await admin.end()

  execFileSync('yarn', ['workspace', '@hitly/db', 'db:migrate'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: TARGET_URL },
    stdio: 'pipe',
    timeout: 180_000,
  })

  process.env.DATABASE_URL = TARGET_URL
  const fixtureMod = await import('./m0h-fixture')
  fx = await fixtureMod.createM0hFixture()
  tier = await import('./tier-enforcement')
  invites = await import('./invites')
  projectCreate = await import('./project-create')
  lifecycle = await import('./project-lifecycle')
  approvalsLib = await import('./approvals')
  const tenantMod = await import('./tenant')
  withTenant = tenantMod.withTenant
  requireDb = tenantMod.requireDb

  client = new pg.Client({ connectionString: TARGET_URL })
  await client.connect()
  await client.query('UPDATE workspaces SET plan = $2 WHERE id = $1', [fx.workspaceId, 'solo'])
})

after(async () => {
  await client?.end().catch(() => undefined)
  // The fixture holds its own pg.Client: close every app-held connection
  // BEFORE the FORCE drop, or the drop kills them and their error handlers
  // fire as uncaughtException after the test has already ended.
  try {
    const fixtureMod = await import('./m0h-fixture')
    if (fx) await fixtureMod.closeM0hFixture(fx)
  } catch {
    // fixture never opened
  }
  try {
    const { pool } = await import('./db')
    await pool?.end()
  } catch {
    // pool already gone
  }
  const admin = new pg.Client({ connectionString: BASE_URL })
  try {
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
  } catch {
    // best-effort; the next run drops-if-exists first
  } finally {
    await admin.end().catch(() => undefined)
  }
})

describe('decisions per month (ingestApproval)', () => {
  const cleanup: string[] = []
  after(async () => {
    await client.query('DELETE FROM decision_records WHERE approval_id = ANY($1)', [cleanup])
    await client.query('DELETE FROM approvals WHERE id = ANY($1)', [cleanup])
    await setCap('solo', 'decisions_per_month', 300)
  })

  it('at-cap NEW ingest is refused with 402 + stable code; under-cap the next ingest is allowed', async () => {
    await setCap('solo', 'decisions_per_month', 2)
    await seedApproval('apr_te_d1', new Date(), 'pending')
    await seedApproval('apr_te_d2', new Date(), 'pending')
    cleanup.push('apr_te_d1', 'apr_te_d2')
    assert.equal(await monthApprovalRows(), 2)

    const refused = await approvalsLib.ingestApproval({
      apiKey: fx.apiKey,
      body: { runId: 'te-run-1', actionName: 'te.a', args: {} },
    })
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.equal(refused.status, 402)
      assert.equal(refused.code, 'tier_limit_reached')
      assert.match(refused.error, /Monthly decision limit reached \(2 of 2 decisions used this month\)/)
    }

    // Under-cap: one row less, the very next NEW ingest succeeds.
    await client.query('DELETE FROM approvals WHERE id = $1', ['apr_te_d2'])
    const allowed = await approvalsLib.ingestApproval({
      apiKey: fx.apiKey,
      body: { runId: 'te-run-2', actionName: 'te.a', args: {} },
    })
    assert.equal(allowed.ok, true, allowed.ok ? '' : allowed.error)
    if (allowed.ok) cleanup.push(allowed.approval.id)
  })

  it('an idempotent replay at the cap is NOT new use: it replays, never refuses', async () => {
    await setCap('solo', 'decisions_per_month', 99)
    const first = await approvalsLib.ingestApproval({
      apiKey: fx.apiKey,
      body: { runId: 'te-run-replay', actionName: 'te.r', args: { x: 1 } },
      idempotencyKey: 'te-idem-1',
    })
    assert.equal(first.ok, true, first.ok ? '' : first.error)
    if (first.ok) cleanup.push(first.approval.id)

    await setCap('solo', 'decisions_per_month', 2)
    const replay = await approvalsLib.ingestApproval({
      apiKey: fx.apiKey,
      body: { runId: 'te-run-replay', actionName: 'te.r', args: { x: 1 } },
      idempotencyKey: 'te-idem-1',
    })
    assert.equal(replay.ok, true, replay.ok ? '' : replay.error)
    if (replay.ok) assert.equal(replay.replayed, true)

    // The same request WITHOUT the replay identity is new use at the cap: refused.
    const fresh = await approvalsLib.ingestApproval({
      apiKey: fx.apiKey,
      body: { runId: 'te-run-replay-other', actionName: 'te.r', args: { x: 1 } },
      idempotencyKey: 'te-idem-2',
    })
    assert.equal(fresh.ok, false)
  })
})

describe('seats (invite send / member add)', () => {
  after(async () => {
    await client.query('DELETE FROM invites WHERE workspace_id = $1', [fx.workspaceId])
    await client.query("DELETE FROM memberships WHERE user_id LIKE 'usr_te_%'")
    await client.query("DELETE FROM users WHERE id LIKE 'usr_te_%'")
    await setCap('solo', 'seats', 2)
  })

  async function seedUser(id: string, email: string): Promise<void> {
    await client.query(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [id, id, email],
    )
  }
  async function seedMembership(userId: string): Promise<void> {
    await client.query(
      `INSERT INTO memberships (id, workspace_id, user_id, role, created_at)
       VALUES ($1, $2, $3, 'member', now()) ON CONFLICT DO NOTHING`,
      [`mem_${userId}`, fx.workspaceId, userId],
    )
  }
  async function seedPendingInvite(email: string, daysToExpiry = 1): Promise<void> {
    // token_hash is UNIQUE — derive it from the address so seeds never collide.
    const tokenHash = createHash('sha256').update(`te-invite:${email}`).digest('hex')
    await client.query(
      `INSERT INTO invites (id, workspace_id, email, role, token_hash, expires_at)
       VALUES ($1, $2, $3, 'member', $4, now() + ($5 || ' days')::interval)`,
      [`inv_te_${email}`, fx.workspaceId, email, tokenHash, String(daysToExpiry)],
    )
  }

  it('counts members + live pending invites (expired and accepted ones excluded)', async () => {
    await seedUser('usr_te_a', 'a@te.invalid')
    await seedMembership('usr_te_a')
    await seedPendingInvite('pending@te.invalid')
    await seedPendingInvite('old@te.invalid', -2) // expired: not counted
    const usage = await withTenant(fx.workspaceId, () => tier.seatUnits(requireDb(), fx.workspaceId))
    // fixture reviewer + usr_te_a + 1 live pending (expired excluded)
    assert.equal(usage, 3)
  })

  it('at-cap member add and NEW invite are refused with no rows written; re-inviting the SAME address is not new use', async () => {
    await setCap('solo', 'seats', 2) // fixture reviewer + usr_te_a from the previous test
    await seedUser('usr_te_b', 'b@te.invalid')
    const sendStub = (async () => ({ delivered: true as const })) as unknown as typeof import('@hitly/mail').sendMail

    const memberAdd = await withTenant(fx.workspaceId, async () => {
      try {
        await invites.addExistingUserToWorkspace({
          workspaceId: fx.workspaceId,
          workspaceName: 'Te',
          userId: 'usr_te_b',
          email: 'b@te.invalid',
          role: 'member',
          actorUserId: fx.reviewerId,
          appUrl: 'http://localhost:3001',
          database: requireDb(),
          send: sendStub,
        })
        return 'no-throw'
      } catch (error) {
        return error
      }
    })
    assert.ok(memberAdd instanceof tier.TierLimitError, 'at-cap add must throw the typed refusal')
    assert.equal((memberAdd as { refusal: { limitKey: string } }).refusal.limitKey, 'seats')
    const rows = await client.query("SELECT 1 FROM memberships WHERE user_id = 'usr_te_b'")
    assert.equal(rows.rowCount, 0, 'refused add writes no membership')

    const newInvite = await withTenant(fx.workspaceId, async () => {
      try {
        await invites.createAndSendWorkspaceInvite({
          workspaceId: fx.workspaceId,
          workspaceName: 'Te',
          email: 'new@te.invalid',
          role: 'member',
          invitedByUserId: fx.reviewerId,
          actorUserId: fx.reviewerId,
          appUrl: 'http://localhost:3001',
          database: requireDb(),
          send: sendStub,
        })
        return 'no-throw'
      } catch (error) {
        return error
      }
    })
    assert.ok(newInvite instanceof tier.TierLimitError, 'at-cap NEW invite must throw')
    assert.match((newInvite as Error).message, /Seat limit reached \(2 of 2 seats in use/)
    const inviteRows = await client.query("SELECT 1 FROM invites WHERE email = 'new@te.invalid'")
    assert.equal(inviteRows.rowCount, 0, 'refused invite writes no row')

    // Re-inviting the SAME address replaces that pending invite: seat count
    // unchanged, so it is allowed even though every OTHER new seat would be
    // refused at the cap. (Isolate: drop other pendings first.)
    await client.query("DELETE FROM invites WHERE workspace_id = $1 AND email <> 'replace@te.invalid'", [fx.workspaceId])
    await seedPendingInvite('replace@te.invalid') // members 2 + this pending 1; minus replaced row = exactly cap
    const replaceInvite = await withTenant(fx.workspaceId, () =>
      invites.createAndSendWorkspaceInvite({
        workspaceId: fx.workspaceId,
        workspaceName: 'Te',
        email: 'replace@te.invalid',
        role: 'member',
        invitedByUserId: fx.reviewerId,
        actorUserId: fx.reviewerId,
        appUrl: 'http://localhost:3001',
        database: requireDb(),
        send: sendStub,
      }),
    )
    assert.ok(replaceInvite && typeof replaceInvite.id === 'string', 'same-address re-invite replaces and succeeds at the cap')
  })

  it('self-hosted (NULL cap) is never seat-capped; a removed cap row fails closed', async () => {
    await setCap('solo', 'seats', 2)
    const selfHosted = await tier.gateSeat({ plan: 'self-hosted' }, 999)
    assert.equal(selfHosted.allowed, true)

    await client.query("DELETE FROM tier_limits WHERE plan = 'solo' AND limit_key = 'seats'")
    const denied = await tier.gateSeat({ plan: 'solo' }, 0)
    assert.equal(denied.allowed, false, 'missing cap row denies like a cap of zero')
    if (!denied.allowed) assert.equal(denied.message, tier.TIER_NOT_AVAILABLE_MESSAGE)
    await setCap('solo', 'seats', 2)
  })
})

describe('live projects (create / resume / unarchive)', () => {
  after(async () => {
    await client.query("DELETE FROM project_memberships WHERE project_id LIKE 'prj_te%'")
    await client.query("DELETE FROM project_channels WHERE project_id LIKE 'prj_te%'")
    await client.query("DELETE FROM projects WHERE name IN ('Te Refused', 'Te Allowed', 'Te Second') OR id LIKE 'prj_te%'")
    await client.query("UPDATE projects SET status = 'live' WHERE id = $1", [fx.projectId])
    await setCap('solo', 'live_projects', 2)
  })

  it('at-cap create is refused before any write; pausing one frees a slot; entering live over the cap is refused; leaving live is free', async () => {
    await setCap('solo', 'live_projects', 2)
    // fixture project is live; seed one more so the cap is exactly reached.
    await client.query(
      `INSERT INTO projects (id, workspace_id, name, plugin, status, credentials, created_at, updated_at)
       VALUES ('prj_te_extra', $1, 'Te Extra', 'http', 'live', '{}'::jsonb, now(), now())`,
      [fx.workspaceId],
    )
    const createRefused = await withTenant(fx.workspaceId, async () => {
      try {
        await projectCreate.insertNewProject({ userId: fx.reviewerId, name: 'Te Refused', description: '', plugin: 'http' })
        return 'no-throw'
      } catch (error) {
        return error
      }
    })
    assert.ok(createRefused instanceof tier.TierLimitError, 'at-cap create must throw the refusal')
    assert.equal((createRefused as { refusal: { limitKey: string } }).refusal.limitKey, 'live_projects')
    assert.match((createRefused as Error).message, /Live project limit reached \(2 of 2 projects live at once\)/)
    const stray = await client.query("SELECT 1 FROM projects WHERE name = 'Te Refused'")
    assert.equal(stray.rowCount, 0, 'refused create writes no project')

    // Free a slot: pause the fixture project, then create succeeds (born live).
    await client.query("UPDATE projects SET status = 'paused' WHERE id = $1", [fx.projectId])
    const projectId = await withTenant(fx.workspaceId, () =>
      projectCreate.insertNewProject({ userId: fx.reviewerId, name: 'Te Allowed', description: '', plugin: 'http' }),
    )
    assert.match(projectId, /^prj_/)

    // The paused fixture project may not enter live again while Te Allowed is live.
    const resumeRefused = await withTenant(fx.workspaceId, () =>
      lifecycle.setProjectStatus({
        projectId: fx.projectId,
        status: 'live',
        workspaceRole: 'owner',
        workspace: { id: fx.workspaceId, plan: 'solo' },
      }),
    )
    assert.equal(resumeRefused.ok, false)
    if (!resumeRefused.ok) {
      assert.equal(resumeRefused.code, 'tier_limit_reached')
      assert.equal(resumeRefused.status, 402)
    }
    const stillPaused = await client.query('SELECT status FROM projects WHERE id = $1', [fx.projectId])
    assert.equal(stillPaused.rows[0].status, 'paused', 'refused transition leaves the status untouched')

    // Leaving live is never blocked (existing data stays manageable).
    const pauseAgain = await withTenant(fx.workspaceId, () =>
      lifecycle.setProjectStatus({
        projectId: projectId,
        status: 'paused',
        workspaceRole: 'owner',
        workspace: { id: fx.workspaceId, plan: 'solo' },
      }),
    )
    assert.equal(pauseAgain.ok, true, pauseAgain.ok ? '' : pauseAgain.error)
  })
})

describe('retention-bound retry (retryResume vs completed_retention_days)', () => {
  after(async () => {
    await client.query("DELETE FROM decision_records WHERE approval_id LIKE 'apr_te_fr%'")
    await client.query("DELETE FROM approvals WHERE id LIKE 'apr_te_fr%'")
  })

  async function seedFailedResume(id: string, createdAt: Date): Promise<void> {
    await seedApproval(id, createdAt, 'failed_resume')
    await client.query(
      `INSERT INTO decision_records (id, workspace_id, approval_id, actor_user_id, decision, payload, created_at)
       VALUES ($1, $2, $3, $4, 'accept', '{}'::jsonb, $5)`,
      [`dec_${id}`, fx.workspaceId, id, fx.reviewerId, createdAt],
    )
  }

  it('retry of an item older than the plan retention is refused with the stable code (before any resume)', async () => {
    await seedFailedResume('apr_te_fr_old', new Date(Date.now() - 12 * DAY)) // solo retention: 10 days
    const result = (await withTenant(fx.workspaceId, () =>
      approvalsLib.retryResume({ approvalId: 'apr_te_fr_old', workspaceId: fx.workspaceId }),
    )) as { error?: string; code?: string; status?: number }
    assert.equal(result.code, 'tier_limit_reached')
    assert.match(String(result.error), /12 days old — past your plan's 10-day retention/)
    assert.equal(result.status, 402)
  })

  it('retry of an item inside the retention window is NOT tier-refused (gate stays out of the way)', async () => {
    await seedFailedResume('apr_te_fr_fresh', new Date(Date.now() - 2 * DAY))
    let result: { code?: string; error?: string }
    try {
      result = (await withTenant(fx.workspaceId, () =>
        approvalsLib.retryResume({ approvalId: 'apr_te_fr_fresh', workspaceId: fx.workspaceId }),
      )) as { code?: string; error?: string }
    } catch (error) {
      // Downstream resume plumbing may fail in the sandbox; that is not a refusal.
      result = { code: undefined, error: String(error) }
    }
    assert.notEqual(result.code, 'tier_limit_reached', `in-window retry must not be tier-refused: ${result.error}`)
  })

  it('reads of an aged item stay allowed (existing data is never blocked)', async () => {
    await seedFailedResume('apr_te_fr_read', new Date(Date.now() - 400 * DAY))
    const read = await client.query('SELECT id FROM approvals WHERE id = $1', ['apr_te_fr_read'])
    assert.equal(read.rowCount, 1, 'the aged row is still stored')
    const detail = await withTenant(fx.workspaceId, () =>
      requireDb()
        .select({ id: approvalsSchema.id })
        .from(approvalsSchema)
        .where(eq(approvalsSchema.id, 'apr_te_fr_read')),
    )
    assert.equal(detail.length, 1, 'the tenant read path still returns the aged row')
  })
})
