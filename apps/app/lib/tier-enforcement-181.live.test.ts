/**
 * LIVE Postgres, own throwaway database (hitly_tier_181): hitly#181
 * API-key caps, workspace scope, delete/rotate semantics, NULL caps, and
 * concurrent creates at cap−1 for API keys, live projects and seats.
 *
 * Gated the same way as lib/tier-enforcement.live.test.ts: included in the
 * apps/app "test" script, creates its own DB, migrates it, then imports the
 * app modules. CI supplies DATABASE_URL and HITLY_ENCRYPTION_KEK.
 *
 * On current main and on #175 the API-key and race cases fail because
 * insertNewProjectApiKey is uncapped and the check-then-write races are
 * unguarded.
 *
 * Addendum 22 Nov: also pins the #175 probe-only kills T2, T3, T5 and T9
 * as committed repo tests (plan-to-cap resolution, NULL checkQuota,
 * member-add seat gate, monthly decisions window). Those four are expected
 * green on a #175-inclusive baseline and must fail under the named mutant.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, afterEach, before, describe, it } from 'node:test'
import path from 'node:path'
import pg from 'pg'
import { TIER_LIMIT_SEED } from '@hitly/core'

// Must be set before the app pool is imported (default HITLY_DB_POOL_MAX is 10).
process.env.HITLY_DB_POOL_MAX = process.env.HITLY_DB_POOL_MAX ?? '32'
process.env.HITLY_TIER_LIMITS_TTL_MS = '0'

const BASE_URL = process.env.DATABASE_URL ?? ['postgres://', 'hitly:hitly@localhost:5432/', 'hitly'].join('')
const REPO_ROOT = path.join(__dirname, '../../..')
const DB = 'hitly_tier_181'
const RACE_N = 20
const RACE_REPEATS = 5

function urlWithDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}
const TARGET_URL = urlWithDatabase(BASE_URL, DB)

let client: pg.Client
let fx: import('./m0h-fixture').M0hFixture
let projectCreate: typeof import('./project-create')
let invites: typeof import('./invites')
let withTenant: <T>(workspaceId: string, fn: () => Promise<T>) => Promise<T>
let requireDb: () => import('./tenant').TenantDatabase
let seatUnits: ((database: import('./tenant').TenantDatabase, workspaceId: string) => Promise<number>) | undefined
let approvalsCreatedThisMonth:
  | ((database: import('./tenant').TenantDatabase, workspaceId: string) => Promise<number>)
  | undefined
let approvalsLib: typeof import('./approvals') | undefined
let limitFn: typeof import('./tier-limits').limit | undefined
let checkQuotaFn: typeof import('./tier-limits').checkQuota | undefined
let invalidateTierLimitsCache: (() => void) | undefined
const DAY_MS = 24 * 60 * 60 * 1000

function isTierRefusal(
  error: unknown,
): error is { code?: string; message?: string; refusal?: { code?: string; limitKey?: string; message?: string } } {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; refusal?: { code?: unknown } }
  return value.code === 'tier_limit_reached' || value.refusal?.code === 'tier_limit_reached'
}

function limitKeyOf(error: unknown): string | undefined {
  if (!isTierRefusal(error)) return undefined
  return error.refusal?.limitKey
}

async function setPlan(workspaceId: string, plan: string): Promise<void> {
  await client.query('UPDATE workspaces SET plan = $2 WHERE id = $1', [workspaceId, plan])
}

async function setCap(plan: string, key: string, value: number | null): Promise<void> {
  await client.query(
    'INSERT INTO tier_limits (plan, limit_key, value) VALUES ($1, $2, $3) ON CONFLICT (plan, limit_key) DO UPDATE SET value = EXCLUDED.value',
    [plan, key, value],
  )
  invalidateTierLimitsCache?.()
}

async function seedApproval(id: string, createdAt: Date, status = 'pending'): Promise<void> {
  await client.query(
    `INSERT INTO approvals (id, workspace_id, project_id, plugin, status, action_name, envelope, origin, created_at, updated_at)
     VALUES ($1, $2, $3, 'http', $4, 'te.action', '{}'::jsonb, '{}'::jsonb, $5, $5)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, created_at = EXCLUDED.created_at`,
    [id, fx.workspaceId, fx.projectId, status, createdAt],
  )
}

async function keyCount(workspaceId: string, projectId?: string): Promise<number> {
  const result = projectId
    ? await client.query(
        'SELECT count(*)::int AS n FROM project_api_keys WHERE workspace_id = $1 AND project_id = $2',
        [workspaceId, projectId],
      )
    : await client.query('SELECT count(*)::int AS n FROM project_api_keys WHERE workspace_id = $1', [workspaceId])
  return result.rows[0].n as number
}

async function liveProjectCount(workspaceId: string): Promise<number> {
  const result = await client.query(
    "SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1 AND status = 'live'",
    [workspaceId],
  )
  return result.rows[0].n as number
}

async function createKey(
  name: string,
  projectId = fx.projectId,
  workspaceId = fx.workspaceId,
  userId = fx.reviewerId,
): Promise<{ ok: true; raw: string } | { ok: false; error: unknown }> {
  try {
    const raw = await withTenant(workspaceId, () =>
      projectCreate.insertNewProjectApiKey({ projectId, userId, name }),
    )
    return { ok: true, raw }
  } catch (error) {
    return { ok: false, error }
  }
}

async function seedSecondProject(id: string, workspaceId = fx.workspaceId): Promise<void> {
  await client.query(
    `INSERT INTO projects (id, workspace_id, name, plugin, status, credentials, created_at, updated_at)
     VALUES ($1, $2, $3, 'http', 'live', '{}'::jsonb, now(), now())`,
    [id, workspaceId, id],
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
  projectCreate = await import('./project-create')
  invites = await import('./invites')
  const tenantMod = await import('./tenant')
  withTenant = tenantMod.withTenant
  requireDb = tenantMod.requireDb
  try {
    const tier = await import('./tier-enforcement')
    seatUnits = tier.seatUnits
    approvalsCreatedThisMonth = tier.approvalsCreatedThisMonth
  } catch {
    seatUnits = undefined
    approvalsCreatedThisMonth = undefined
  }
  try {
    approvalsLib = await import('./approvals')
  } catch {
    approvalsLib = undefined
  }
  const limitsMod = await import('./tier-limits')
  limitFn = limitsMod.limit
  checkQuotaFn = limitsMod.checkQuota
  invalidateTierLimitsCache = limitsMod.invalidateTierLimitsCache

  client = new pg.Client({ connectionString: TARGET_URL })
  await client.connect()
  await setPlan(fx.workspaceId, 'solo')
})

after(async () => {
  await client?.end().catch(() => undefined)
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
    // best-effort
  } finally {
    await admin.end().catch(() => undefined)
  }
})

describe('api_keys (insertNewProjectApiKey)', () => {
  afterEach(async () => {
    await client.query('DELETE FROM project_api_keys WHERE workspace_id = $1 AND name <> $2', [
      fx.workspaceId,
      'M0h Key',
    ])
    // Keep the fixture key so the workspace starts each test at usage 1.
    const leftover = await client.query(
      "SELECT 1 FROM project_api_keys WHERE workspace_id = $1 AND name = 'M0h Key'",
      [fx.workspaceId],
    )
    if (leftover.rowCount === 0) {
      await client.query(
        `INSERT INTO project_api_keys (id, workspace_id, project_id, name, hashed_key, prefix, created_at)
         VALUES ($1, $2, $3, 'M0h Key', $4, 'hitly_fix', now())`,
        [`key_fix_${Date.now()}`, fx.workspaceId, fx.projectId, `hashed-fix-${Date.now()}`],
      )
    }
    await client.query("DELETE FROM projects WHERE id LIKE 'prj_181_%'")
    await setPlan(fx.workspaceId, 'solo')
  })

  it('at-cap create is refused with the stable code; row count unchanged (solo seed cap 2)', async () => {
    assert.equal(TIER_LIMIT_SEED.api_keys.solo, 2)
    assert.equal(await keyCount(fx.workspaceId), 1, 'fixture already holds one key (cap−1)')
    const allowed = await createKey('second')
    assert.equal(allowed.ok, true, allowed.ok ? '' : String((allowed as { error: unknown }).error))
    assert.equal(await keyCount(fx.workspaceId), 2)

    const refused = await createKey('third')
    assert.equal(refused.ok, false, 'the 3rd solo key must be refused')
    assert.ok(isTierRefusal(refused.ok ? undefined : refused.error), 'refusal must use the #175 tier vocabulary')
    assert.equal(limitKeyOf(refused.ok ? undefined : refused.error), 'api_keys')
    const message = String((refused as { error: { message?: string; refusal?: { message?: string } } }).error?.refusal?.message
      ?? (refused as { error: { message?: string } }).error?.message
      ?? '')
    assert.match(message, /API key/i)
    assert.match(message, /2 of 2/)
    assert.equal(await keyCount(fx.workspaceId), 2, 'refused create writes no row')
  })

  it('under-cap create is allowed and consumes one slot', async () => {
    assert.equal(await keyCount(fx.workspaceId), 1)
    const allowed = await createKey('under-cap')
    assert.equal(allowed.ok, true, allowed.ok ? '' : String((allowed as { error: unknown }).error))
    assert.equal(await keyCount(fx.workspaceId), 2)
  })

  it('at-cap create is refused against the real Pro seed cap 10', async () => {
    assert.equal(TIER_LIMIT_SEED.api_keys.pro, 10)
    await setPlan(fx.workspaceId, 'pro')
    for (let i = 0; i < 9; i++) {
      const result = await createKey(`pro-${i}`)
      assert.equal(result.ok, true, `seeding pro key ${i}: ${result.ok ? '' : String(result.error)}`)
    }
    assert.equal(await keyCount(fx.workspaceId), 10)
    const refused = await createKey('pro-over')
    assert.equal(refused.ok, false, 'the 11th Pro key must be refused')
    assert.equal(limitKeyOf(refused.ok ? undefined : refused.error), 'api_keys')
    assert.equal(await keyCount(fx.workspaceId), 10)
  })

  it('NULL api_keys caps (team, enterprise, self-hosted) never refuse', async () => {
    for (const plan of ['team', 'enterprise', 'self-hosted'] as const) {
      assert.equal(TIER_LIMIT_SEED.api_keys[plan], null, plan)
      await setPlan(fx.workspaceId, plan)
      await client.query('DELETE FROM project_api_keys WHERE workspace_id = $1 AND name <> $2', [
        fx.workspaceId,
        'M0h Key',
      ])
      for (let i = 0; i < 11; i++) {
        const result = await createKey(`${plan}-${i}`)
        assert.equal(result.ok, true, `${plan} key ${i} must be allowed (NULL cap): ${result.ok ? '' : String(result.error)}`)
      }
      assert.equal(await keyCount(fx.workspaceId), 12, `${plan} must allow usage well above the Pro cap`)
    }
  })

  it('cap is per workspace, not per project', async () => {
    await seedSecondProject('prj_181_b')
    const second = await createKey('on-a')
    assert.equal(second.ok, true, second.ok ? '' : String(second.error))
    assert.equal(await keyCount(fx.workspaceId), 2)
    const refused = await createKey('on-b', 'prj_181_b')
    assert.equal(refused.ok, false, 'a 3rd workspace key must be refused even on another project')
    assert.equal(limitKeyOf(refused.ok ? undefined : refused.error), 'api_keys')
    assert.equal(await keyCount(fx.workspaceId, 'prj_181_b'), 0)
    assert.equal(await keyCount(fx.workspaceId), 2)
  })

  it('cap does not leak across workspaces', async () => {
    const second = await createKey('fill-a')
    assert.equal(second.ok, true, second.ok ? '' : String(second.error))
    assert.equal(await keyCount(fx.workspaceId), 2)

    const fixtureMod = await import('./m0h-fixture')
    const other = await fixtureMod.createM0hFixture()
    try {
      await setPlan(other.workspaceId, 'solo')
      assert.equal(await keyCount(other.workspaceId), 1)
      const created = await createKey('other-ws', other.projectId, other.workspaceId, other.reviewerId)
      assert.equal(created.ok, true, created.ok ? '' : String(created.error))
      assert.equal(await keyCount(other.workspaceId), 2)
      assert.equal(await keyCount(fx.workspaceId), 2, 'workspace A stays at its cap')
    } finally {
      await client.query('DELETE FROM project_api_keys WHERE workspace_id = $1', [other.workspaceId])
      await client.query('DELETE FROM project_memberships WHERE workspace_id = $1', [other.workspaceId])
      await client.query('DELETE FROM project_channels WHERE workspace_id = $1', [other.workspaceId])
      await client.query('DELETE FROM projects WHERE workspace_id = $1', [other.workspaceId])
      await client.query('DELETE FROM memberships WHERE workspace_id = $1', [other.workspaceId])
      await client.query('DELETE FROM workspaces WHERE id = $1', [other.workspaceId])
      await client.query('DELETE FROM users WHERE id = $1', [other.reviewerId])
      await fixtureMod.closeM0hFixture(other)
    }
  })

  it('deleting a key frees a slot', async () => {
    const second = await createKey('to-delete')
    assert.equal(second.ok, true, second.ok ? '' : String(second.error))
    assert.equal(await keyCount(fx.workspaceId), 2)
    const refused = await createKey('while-full')
    assert.equal(refused.ok, false)

    const doomed = await client.query(
      "SELECT id FROM project_api_keys WHERE workspace_id = $1 AND name = 'to-delete'",
      [fx.workspaceId],
    )
    assert.equal(doomed.rowCount, 1)
    await client.query('DELETE FROM project_api_keys WHERE id = $1', [doomed.rows[0].id])
    assert.equal(await keyCount(fx.workspaceId), 1)

    const freed = await createKey('after-delete')
    assert.equal(freed.ok, true, freed.ok ? '' : String(freed.error))
    assert.equal(await keyCount(fx.workspaceId), 2)
  })

  it('rotating a key at the cap does not increment usage', async () => {
    const second = await createKey('rotate-target')
    assert.equal(second.ok, true, second.ok ? '' : String(second.error))
    assert.equal(await keyCount(fx.workspaceId), 2)
    const row = await client.query(
      "SELECT id, hashed_key FROM project_api_keys WHERE workspace_id = $1 AND name = 'rotate-target'",
      [fx.workspaceId],
    )
    assert.equal(row.rowCount, 1)
    const beforeHash = row.rows[0].hashed_key as string

    const raw = await withTenant(fx.workspaceId, () =>
      projectCreate.rotateProjectApiKeyRecord({
        projectId: fx.projectId,
        keyId: row.rows[0].id as string,
        userId: fx.reviewerId,
      }),
    )
    assert.equal(typeof raw, 'string')
    assert.equal(await keyCount(fx.workspaceId), 2, 'rotation must not insert a new row')
    const after = await client.query('SELECT hashed_key FROM project_api_keys WHERE id = $1', [row.rows[0].id])
    assert.notEqual(after.rows[0].hashed_key, beforeHash, 'the stored secret rotated')

    const stillRefused = await createKey('after-rotate')
    assert.equal(stillRefused.ok, false, 'create stays at the cap after a rotation')
    assert.equal(await keyCount(fx.workspaceId), 2)
  })
})

describe('races at cap-1 (real PG, N=20, 5 repeats)', () => {
  const sendStub = (async () => ({ delivered: true as const })) as unknown as typeof import('@hitly/mail').sendMail

  afterEach(async () => {
    await client.query('DELETE FROM project_api_keys WHERE workspace_id = $1 AND name <> $2', [
      fx.workspaceId,
      'M0h Key',
    ])
    await client.query("DELETE FROM project_memberships WHERE project_id LIKE 'prj_%' AND project_id <> $1", [
      fx.projectId,
    ])
    await client.query("DELETE FROM project_channels WHERE project_id <> $1", [fx.projectId])
    await client.query("DELETE FROM projects WHERE workspace_id = $1 AND id <> $2", [fx.workspaceId, fx.projectId])
    await client.query('DELETE FROM invites WHERE workspace_id = $1', [fx.workspaceId])
    await setPlan(fx.workspaceId, 'solo')
  })

  it('N parallel API-key creates at cap-1 leave usage at the cap', async () => {
    const cap = TIER_LIMIT_SEED.api_keys.solo
    assert.equal(cap, 2)
    for (let repeat = 0; repeat < RACE_REPEATS; repeat++) {
      await client.query('DELETE FROM project_api_keys WHERE workspace_id = $1 AND name <> $2', [
        fx.workspaceId,
        'M0h Key',
      ])
      assert.equal(await keyCount(fx.workspaceId), cap! - 1, `repeat ${repeat} must start at cap−1`)
      const settled = await Promise.allSettled(
        Array.from({ length: RACE_N }, (_, i) =>
          withTenant(fx.workspaceId, () =>
            projectCreate.insertNewProjectApiKey({
              projectId: fx.projectId,
              userId: fx.reviewerId,
              name: `race-key-${repeat}-${i}`,
            }),
          ),
        ),
      )
      const succeeded = settled.filter((row) => row.status === 'fulfilled').length
      const refused = settled.filter(
        (row) => row.status === 'rejected' && isTierRefusal(row.reason),
      ).length
      const other = RACE_N - succeeded - refused
      const usage = await keyCount(fx.workspaceId)
      assert.equal(other, 0, `repeat ${repeat}: unexpected errors: ${summariseOther(settled)}`)
      assert.equal(usage, cap, `repeat ${repeat}: expected usage ${cap}, got ${usage} (succeeded=${succeeded}, refused=${refused})`)
      assert.equal(succeeded, 1, `repeat ${repeat}: exactly one create should succeed from cap−1`)
    }
  })

  it('N parallel project creates at cap-1 leave live count at the cap', async () => {
    const cap = TIER_LIMIT_SEED.live_projects.solo
    assert.equal(cap, 2)
    for (let repeat = 0; repeat < RACE_REPEATS; repeat++) {
      await client.query("DELETE FROM project_memberships WHERE project_id LIKE 'prj_%' AND project_id <> $1", [
        fx.projectId,
      ])
      await client.query('DELETE FROM project_channels WHERE project_id <> $1', [fx.projectId])
      await client.query('DELETE FROM projects WHERE workspace_id = $1 AND id <> $2', [fx.workspaceId, fx.projectId])
      assert.equal(await liveProjectCount(fx.workspaceId), cap! - 1, `repeat ${repeat} must start at cap−1`)
      const settled = await Promise.allSettled(
        Array.from({ length: RACE_N }, (_, i) =>
          withTenant(fx.workspaceId, () =>
            projectCreate.insertNewProject({
              userId: fx.reviewerId,
              name: `Te Race ${repeat} ${i}`,
              description: '',
              plugin: 'http',
            }),
          ),
        ),
      )
      const succeeded = settled.filter((row) => row.status === 'fulfilled').length
      const refused = settled.filter(
        (row) => row.status === 'rejected' && isTierRefusal(row.reason),
      ).length
      const other = RACE_N - succeeded - refused
      const usage = await liveProjectCount(fx.workspaceId)
      assert.equal(other, 0, `repeat ${repeat}: unexpected errors: ${summariseOther(settled)}`)
      assert.equal(usage, cap, `repeat ${repeat}: expected live ${cap}, got ${usage} (succeeded=${succeeded}, refused=${refused})`)
      assert.equal(succeeded, 1, `repeat ${repeat}: exactly one project should succeed from cap−1`)
    }
  })

  it('N parallel invite-sends at cap-1 leave seat usage at the cap', async () => {
    const cap = TIER_LIMIT_SEED.seats.solo
    assert.equal(cap, 2)
    for (let repeat = 0; repeat < RACE_REPEATS; repeat++) {
      await client.query('DELETE FROM invites WHERE workspace_id = $1', [fx.workspaceId])
      const settled = await Promise.allSettled(
        Array.from({ length: RACE_N }, (_, i) =>
          withTenant(fx.workspaceId, () =>
            invites.createAndSendWorkspaceInvite({
              workspaceId: fx.workspaceId,
              workspaceName: 'Te',
              email: `race-${repeat}-${i}@te.invalid`,
              role: 'member',
              invitedByUserId: fx.reviewerId,
              actorUserId: fx.reviewerId,
              appUrl: 'http://localhost:3001',
              database: requireDb(),
              send: sendStub,
            }),
          ),
        ),
      )
      const succeeded = settled.filter((row) => row.status === 'fulfilled').length
      const refused = settled.filter(
        (row) => row.status === 'rejected' && isTierRefusal(row.reason),
      ).length
      const other = RACE_N - succeeded - refused
      const usage = seatUnits
        ? await withTenant(fx.workspaceId, () => seatUnits!(requireDb(), fx.workspaceId))
        : await countSeatsFallback(fx.workspaceId)
      assert.equal(other, 0, `repeat ${repeat}: unexpected errors: ${summariseOther(settled)}`)
      assert.equal(usage, cap, `repeat ${repeat}: expected seats ${cap}, got ${usage} (succeeded=${succeeded}, refused=${refused})`)
      assert.equal(succeeded, 1, `repeat ${repeat}: exactly one invite should succeed from cap−1`)
    }
  })
})

describe('#175 T2/T3 repo pins (plan-to-cap and NULL)', () => {
  it('limit() resolves caps from the workspace plan, not a hard-coded Pro row', async () => {
    assert.ok(limitFn, 'apps/app/lib/tier-limits.ts limit() must be importable')
    invalidateTierLimitsCache?.()
    // Solo vs Pro must differ on every numeric key T2 would flatten to the Pro row.
    assert.deepEqual(await limitFn!({ plan: 'solo' }, 'live_projects'), { status: 'ok', value: 2 })
    assert.deepEqual(await limitFn!({ plan: 'pro' }, 'live_projects'), { status: 'ok', value: 10 })
    assert.deepEqual(await limitFn!({ plan: 'team' }, 'live_projects'), { status: 'ok', value: null })
    assert.deepEqual(await limitFn!({ plan: 'solo' }, 'seats'), { status: 'ok', value: 2 })
    assert.deepEqual(await limitFn!({ plan: 'pro' }, 'seats'), { status: 'ok', value: 3 })
    assert.deepEqual(await limitFn!({ plan: 'enterprise' }, 'seats'), { status: 'ok', value: null })
    assert.deepEqual(await limitFn!({ plan: 'solo' }, 'decisions_per_month'), { status: 'ok', value: 300 })
    assert.deepEqual(await limitFn!({ plan: 'pro' }, 'decisions_per_month'), { status: 'ok', value: 2500 })
    assert.deepEqual(await limitFn!({ plan: 'enterprise' }, 'decisions_per_month'), { status: 'ok', value: null })
    assert.deepEqual(await limitFn!({ plan: 'solo' }, 'api_keys'), { status: 'ok', value: 2 })
    assert.deepEqual(await limitFn!({ plan: 'pro' }, 'api_keys'), { status: 'ok', value: 10 })
    assert.deepEqual(await limitFn!({ plan: 'team' }, 'api_keys'), { status: 'ok', value: null })
    assert.deepEqual(await limitFn!({ plan: 'self-hosted' }, 'live_projects'), { status: 'ok', value: null })
  })

  it('checkQuota allows high usage on NULL plans and refuses at a numeric cap', async () => {
    assert.ok(checkQuotaFn, 'checkQuota must be importable')
    invalidateTierLimitsCache?.()
    const soloAtCap = await checkQuotaFn!({ plan: 'solo' }, 'live_projects', 2)
    assert.equal(soloAtCap.allowed, false, 'solo live_projects cap 2 must refuse usage 2')
    const teamUnlimited = await checkQuotaFn!({ plan: 'team' }, 'live_projects', 12)
    assert.equal(
      teamUnlimited.allowed,
      true,
      'team live_projects is NULL: usage 12 must be allowed (T3 / T2-as-Pro would refuse)',
    )
    const enterpriseSeats = await checkQuotaFn!({ plan: 'enterprise' }, 'seats', 12)
    assert.equal(enterpriseSeats.allowed, true, 'enterprise seats is NULL')
    const selfHosted = await checkQuotaFn!({ plan: 'self-hosted' }, 'decisions_per_month', 20_001)
    assert.equal(selfHosted.allowed, true, 'self-hosted decisions is NULL')
    const soloDecisions = await checkQuotaFn!({ plan: 'solo' }, 'decisions_per_month', 300)
    assert.equal(soloDecisions.allowed, false, 'solo decisions cap 300 must refuse usage 300')
  })
})

describe('#175 T5 repo pin (member-add seat gate)', () => {
  const sendStub = (async () => ({ delivered: true as const })) as unknown as typeof import('@hitly/mail').sendMail

  afterEach(async () => {
    await client.query("DELETE FROM memberships WHERE user_id LIKE 'usr_181_%'")
    await client.query("DELETE FROM users WHERE id LIKE 'usr_181_%'")
    await setPlan(fx.workspaceId, 'solo')
  })

  it('addExistingUserToWorkspace at the solo seat cap is refused and writes no membership', async () => {
    assert.equal(TIER_LIMIT_SEED.seats.solo, 2)
    await setPlan(fx.workspaceId, 'solo')
    await client.query(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
      ['usr_181_a', 'usr_181_a', 'a@181.invalid'],
    )
    await client.query(
      `INSERT INTO memberships (id, workspace_id, user_id, role, created_at)
       VALUES ($1, $2, $3, 'member', now()) ON CONFLICT DO NOTHING`,
      ['mem_usr_181_a', fx.workspaceId, 'usr_181_a'],
    )
    await client.query(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
      ['usr_181_b', 'usr_181_b', 'b@181.invalid'],
    )
    // Fixture reviewer + usr_181_a = solo cap 2. A third person is new use.
    const result = await withTenant(fx.workspaceId, async () => {
      try {
        await invites.addExistingUserToWorkspace({
          workspaceId: fx.workspaceId,
          workspaceName: 'Te',
          userId: 'usr_181_b',
          email: 'b@181.invalid',
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
    assert.notEqual(result, 'no-throw', 'at-cap member-add must throw')
    assert.ok(isTierRefusal(result), 'member-add refusal must use the tier vocabulary')
    assert.equal(limitKeyOf(result), 'seats')
    const rows = await client.query("SELECT 1 FROM memberships WHERE user_id = 'usr_181_b'")
    assert.equal(rows.rowCount, 0, 'refused member-add writes no membership')
  })
})

describe('#175 T9 repo pin (monthly decisions window)', () => {
  const cleanupIds: string[] = []

  afterEach(async () => {
    if (cleanupIds.length) {
      await client.query('DELETE FROM decision_records WHERE approval_id = ANY($1)', [cleanupIds])
      await client.query('DELETE FROM approvals WHERE id = ANY($1)', [cleanupIds])
      cleanupIds.length = 0
    }
    await client.query("DELETE FROM decision_records WHERE approval_id LIKE 'apr_181_%'")
    await client.query("DELETE FROM approvals WHERE id LIKE 'apr_181_%'")
    await setCap('solo', 'decisions_per_month', TIER_LIMIT_SEED.decisions_per_month.solo)
    await setPlan(fx.workspaceId, 'solo')
  })

  it('decisions window is the current UTC month: 40-day-old rows do not count; ingest is allowed after rollover', async () => {
    assert.ok(approvalsLib, 'ingestApproval must be importable')
    await setPlan(fx.workspaceId, 'solo')
    await setCap('solo', 'decisions_per_month', 2)
    const now = new Date()
    await seedApproval('apr_181_d1', now)
    await seedApproval('apr_181_d2', now)
    cleanupIds.push('apr_181_d1', 'apr_181_d2')

    if (approvalsCreatedThisMonth) {
      const thisMonth = await withTenant(fx.workspaceId, () =>
        approvalsCreatedThisMonth!(requireDb(), fx.workspaceId),
      )
      assert.equal(thisMonth, 2, 'current-month rows must count')
    }

    const refused = await approvalsLib!.ingestApproval({
      apiKey: fx.apiKey,
      body: { runId: '181-t9-fresh', actionName: 't9.a', args: {} },
    })
    assert.equal(refused.ok, false, 'at-cap ingest this month must be refused')
    if (!refused.ok) {
      assert.equal(refused.code, 'tier_limit_reached')
    }

    // 40 days ago is outside a month window, but still this calendar year
    // in November: a setUTCMonth(0) year window would still count these rows.
    const fortyDaysAgo = new Date(Date.now() - 40 * DAY_MS)
    await client.query("UPDATE approvals SET created_at = $1, updated_at = $1 WHERE id IN ('apr_181_d1', 'apr_181_d2')", [
      fortyDaysAgo,
    ])

    if (approvalsCreatedThisMonth) {
      const afterRollover = await withTenant(fx.workspaceId, () =>
        approvalsCreatedThisMonth!(requireDb(), fx.workspaceId),
      )
      assert.equal(
        afterRollover,
        0,
        '40-day-old rows must fall outside the current UTC month (a year window starting 1 Jan would still count them)',
      )
    }

    const allowed = await approvalsLib!.ingestApproval({
      apiKey: fx.apiKey,
      body: { runId: '181-t9-rollover', actionName: 't9.a', args: {} },
    })
    assert.equal(allowed.ok, true, allowed.ok ? '' : `rollover ingest must be allowed: ${allowed.error}`)
    if (allowed.ok) cleanupIds.push(allowed.approval.id)
  })
})

function summariseOther(settled: PromiseSettledResult<unknown>[]): string {
  return settled
    .filter((row) => row.status === 'rejected' && !isTierRefusal(row.reason))
    .map((row) => (row.status === 'rejected' ? String(row.reason) : ''))
    .join(' | ')
    .slice(0, 800)
}

async function countSeatsFallback(workspaceId: string): Promise<number> {
  const members = await client.query('SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1', [
    workspaceId,
  ])
  const pending = await client.query(
    `SELECT count(*)::int AS n FROM invites
     WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > now()`,
    [workspaceId],
  )
  return (members.rows[0].n as number) + (pending.rows[0].n as number)
}

