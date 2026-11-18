/**
 * LIVE Postgres, own throwaway database: pins the DOWNGRADE-SAFE WIRING of
 * both retention sweeps in jobs.ts (not just the pure retentionWindow()).
 *
 * A "downgrade just happened" (getPlanChangedAt recent) means the sweeps may
 * only delete rows closed AFTER the plan change — everything older, i.e.
 * data the richer plan was retaining, survives. The three scenarios pin,
 * for BOTH sweeps:
 *   A) recent plan change + rows older than the cutoff  -> nothing deleted
 *      (kills "floor dropped" and "floor compared with lt" mutants);
 *   B) no recorded plan change                          -> plain cutoff: old
 *      rows deleted, fresh rows kept (kills "floor always on");
 *   C) plan change older than the export grace          -> plain cutoff
 *      again: old rows deleted (kills "grace never expires").
 *
 * getPlanChangedAt comes from lib/billing, which reads edition.billing at
 * CALL time — so the seam below controls the sweeps precisely. The
 * throwaway database keeps the sweeps away from every other suite's rows.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import path from 'node:path'
import pg from 'pg'
import { edition } from '@hitly/cloud'

const BASE_URL = process.env.DATABASE_URL ?? ['postgres://***:***@localhost:5432/','hitly'].join('')
const REPO_ROOT = path.join(__dirname, '../../..')
const DB = 'hitly_retention_sweep'

function urlWithDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

const TARGET_URL = urlWithDatabase(BASE_URL, DB)
const DAY = 24 * 60 * 60 * 1000

let client: pg.Client
let purgeCompletedApprovals: () => Promise<{ deleted: number }>
let purgeExpiredAuditEvents: () => Promise<{ deleted: number }>
let fakePlanChangedAt: Date | null = null

async function exists(table: string, id: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])
  return r.rowCount === 1
}

async function seedOldRows(): Promise<void> {
  // solo plan: completed retention 10 days (core COMPLETED_RETENTION_DAYS);
  // audit retention on the OSS edition is 3650 days, so the age-eligible
  // audit fixture must be older than that. The 10-day row is fresh under
  // either window.
  await client.query(
    `INSERT INTO approvals (id, workspace_id, project_id, plugin, status, action_name, envelope, origin, created_at, updated_at)
     VALUES ('apr_old', 'ws_sweep', 'prj_sweep', 'mastra', 'decided', 'sweep.action', '{}'::jsonb, '{}'::jsonb,
             now() - interval '40 days', now() - interval '40 days')
     ON CONFLICT (id) DO UPDATE SET status = 'decided',
       created_at = now() - interval '40 days', updated_at = now() - interval '40 days'`,
  )
  await client.query(
    `INSERT INTO project_events (id, workspace_id, project_id, type, message, payload, created_at)
     VALUES ('evt_old', 'ws_sweep', 'prj_sweep', 'sweep.old', 'old', '{}'::jsonb, now() - interval '4000 days'),
            ('evt_fresh', 'ws_sweep', 'prj_sweep', 'sweep.fresh', 'fresh', '{}'::jsonb, now() - interval '10 days')
     ON CONFLICT (id) DO UPDATE SET created_at = CASE project_events.id
       WHEN 'evt_old' THEN now() - interval '4000 days' ELSE now() - interval '10 days' END`,
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
    timeout: 120_000,
  })

  process.env.DATABASE_URL = TARGET_URL
  // Control the seam BEFORE importing the sweeps: the billing wrapper calls
  // edition.billing.* at CALL time, so this fake governs the sweeps exactly.
  ;(edition as { billing?: unknown }).billing = {
    hasActivePaidSubscription: async () => false,
    getPlanChangedAt: async () => fakePlanChangedAt,
  }
  const jobs = await import('./jobs')
  purgeCompletedApprovals = jobs.purgeCompletedApprovals
  purgeExpiredAuditEvents = jobs.purgeExpiredAuditEvents

  client = new pg.Client({ connectionString: TARGET_URL })
  await client.connect()
  await client.query(
    `INSERT INTO workspaces (id, name, slug, plan, created_at, updated_at)
     VALUES ('ws_sweep', 'Sweep Co', 'ws-sweep', 'solo', now(), now())`,
  )
  await client.query(
    `INSERT INTO projects (id, workspace_id, name, plugin, status, credentials, created_at, updated_at)
     VALUES ('prj_sweep', 'ws_sweep', 'Sweep Project', 'mastra', 'live', '{}'::jsonb, now(), now())`,
  )
  await seedOldRows()
})

after(async () => {
  await client?.end().catch(() => undefined)
  try {
    const { pool } = await import('../db')
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

test('A) recent downgrade: both sweeps delete NOTHING older than the change', async () => {
  // Guard first: the seam really is under this file's control.
  fakePlanChangedAt = new Date(Date.now() - 5 * DAY)
  const { getPlanChangedAt } = await import('../billing')
  const seen = await getPlanChangedAt('ws_sweep')
  assert.ok(seen && Math.abs(seen.getTime() - fakePlanChangedAt.getTime()) < 1000, 'the sweep must see the faked plan change instant')

  const completed = await purgeCompletedApprovals()
  const audit = await purgeExpiredAuditEvents()
  assert.equal(completed.deleted, 0, `completed sweep must respect the floor, deleted ${completed.deleted}`)
  assert.equal(audit.deleted, 0, `audit sweep must respect the floor, deleted ${audit.deleted}`)
  assert.ok(await exists('approvals', 'apr_old'), 'approval closed before the downgrade survives the grace')
  assert.ok(await exists('project_events', 'evt_old'), 'audit event from before the downgrade survives the grace')
  assert.ok(await exists('project_events', 'evt_fresh'))
})

test('B) no recorded plan change: plain retention cutoff deletes old, keeps fresh', async () => {
  fakePlanChangedAt = null
  const completed = await purgeCompletedApprovals()
  assert.ok(completed.deleted >= 1, 'without a plan change the approval past 10 days is purged')
  assert.ok(!(await exists('approvals', 'apr_old')), 'apr_old must be deleted with no floor in play')
  const audit = await purgeExpiredAuditEvents()
  assert.ok(audit.deleted >= 1, 'without a plan change the 4000-day audit event is purged')
  assert.ok(!(await exists('project_events', 'evt_old')), 'evt_old must be deleted with no floor in play')
  assert.ok(await exists('project_events', 'evt_fresh'), '10-day-old event is inside the audit window')
})

test('C) plan change older than the export grace: grace expired, old rows purge again', async () => {
  await seedOldRows() // re-insert the rows scenario B deleted
  fakePlanChangedAt = new Date(Date.now() - 45 * DAY) // grace (30d) long expired
  const completed = await purgeCompletedApprovals()
  assert.ok(completed.deleted >= 1, 'after the grace the floor must not protect pre-change rows')
  assert.ok(!(await exists('approvals', 'apr_old')))
  const audit = await purgeExpiredAuditEvents()
  assert.ok(audit.deleted >= 1, 'after the grace the audit floor must be off')
  assert.ok(!(await exists('project_events', 'evt_old')))
  assert.ok(await exists('project_events', 'evt_fresh'))
})
