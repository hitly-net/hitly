/**
 * LIVE Postgres, own process AND own database: the tier_entitlements
 * table is MISSING.
 *
 * Test files run in parallel processes (`tsx --test`), so dropping the
 * table in the shared database would race with the other live suite.
 * Instead this file creates a throwaway database, applies the real
 * migrations to it, drops ONLY that database's tier_entitlements table,
 * and points the helper's DATABASE_URL at it before importing anything
 * that opens a pool.
 *
 * Every read path must deny and log one value-free line — never throw,
 * never 500. An allow-on-error helper fails every assertion here.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://hitly:***@localhost:5432/hitly'
const APP_ORIGIN = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const REPO_ROOT = path.join(__dirname, '../../..')
const MISSING_DB = 'hitly_tier_entitlements_missing'

function urlWithDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

const MISSING_URL = urlWithDatabase(BASE_URL, MISSING_DB)
const MIGRATIONS_URL = urlWithDatabase(BASE_URL, MISSING_DB)

process.env.HITLY_TIER_ENTITLEMENTS_TTL_MS = '0'

let admin: pg.Client
let client: pg.Client
let ENTITLEMENT_FEATURES: readonly string[] = []
let can: (workspace: { plan: string }, feature: string) => Promise<boolean>
let canForCurrentWorkspace: (
  feature: string,
  deps?: { resolveWorkspace?: () => Promise<{ plan: string } | null>; log?: (line: string) => void },
) => Promise<boolean>
let invalidateTierEntitlementsCache: () => void

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  return { lines, restore: () => (console.warn = original) }
}

before(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${MISSING_DB}`)
  await admin.query(`CREATE DATABASE ${MISSING_DB}`)
  await admin.end()

  // Real migrations on the throwaway database (creates AND seeds the table).
  execFileSync('yarn', ['workspace', '@hitly/db', 'db:migrate'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: MIGRATIONS_URL },
    stdio: 'pipe',
    timeout: 120_000,
  })

  // Point the helper at the throwaway database BEFORE importing it (db.ts
  // reads DATABASE_URL at import time). Then drop only the map table.
  process.env.DATABASE_URL = MISSING_URL
  const helper = await import('./tier-entitlements')
  const core = await import('@hitly/core')
  ENTITLEMENT_FEATURES = core.ENTITLEMENT_FEATURES
  can = helper.can
  canForCurrentWorkspace = helper.canForCurrentWorkspace
  invalidateTierEntitlementsCache = helper.invalidateTierEntitlementsCache

  client = new pg.Client({ connectionString: MISSING_URL })
  await client.connect()
  await client.query(`DROP TABLE IF EXISTS tier_entitlements`)
  invalidateTierEntitlementsCache()
})

after(async () => {
  await client?.end().catch(() => undefined)
  // Leave MISSING_DB for post-mortem inspection; the next run drops it first.
})

test('missing tier_entitlements table: every read path denies, logs once, never 500s', async () => {
  // Sanity: the throwaway database had the seed until the line above dropped it.
  // 1. can(): denies with exactly one value-free line; never throws.
  //    Mutant coverage: allow-on-error (or a rethrow) fails here.
  const first = captureWarnings()
  let allowed: boolean | undefined
  try {
    allowed = await can({ plan: 'enterprise' }, 'mfa')
  } finally {
    first.restore()
  }
  assert.equal(allowed, false)
  assert.equal(first.lines.length, 1)
  assert.match(first.lines[0], /\[hitly entitlements\]/)
  assert.match(first.lines[0], /database unavailable; denied "mfa"/)

  // 2. canForCurrentWorkspace (the Security page + enrol gate path).
  const second = captureWarnings()
  try {
    assert.equal(
      await canForCurrentWorkspace('sso_google', {
        resolveWorkspace: async () => ({ plan: 'enterprise' }),
      }),
      false,
    )
  } finally {
    second.restore()
  }
  assert.equal(second.lines.length, 1)
  assert.match(second.lines[0], /database unavailable; denied "sso_google"/)

  // 3. GET /api/v1/workspace/entitlements: 200 with every feature denied.
  const { GET } = await import('../app/api/v1/workspace/entitlements/route')
  const third = captureWarnings()
  try {
    const res = await GET(undefined, {
      resolveSession: async () => ({ ok: true as const, workspace: { plan: 'enterprise' } }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { features: Record<string, boolean> }
    for (const feature of ENTITLEMENT_FEATURES) {
      assert.equal(body.features[feature], false, feature)
    }
  } finally {
    third.restore()
  }

  // 4. POST /api/session/mfa/enrol: 403 FEATURE_UNAVAILABLE, never a 500.
  const { POST } = await import('../app/api/session/mfa/enrol/route')
  const request = new Request(`${APP_ORIGIN}/api/session/mfa/enrol`, {
    method: 'POST',
    headers: { origin: APP_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'x' }),
  })
  const fourth = captureWarnings()
  try {
    const res = await POST(request as never)
    assert.equal(res.status, 403)
    assert.deepEqual((await res.json()).code, 'FEATURE_UNAVAILABLE')
  } finally {
    fourth.restore()
  }
})

test('recovery: a fresh database with the table present allows mfa immediately', async () => {
  // Same process, throwaway database: recreate the table from the real
  // migration file — reads are not failure-cached, so the map works at once.
  const sqlText = fs.readFileSync(
    path.join(REPO_ROOT, 'packages/db/drizzle', '0015_smiling_richard_fisk.sql'),
    'utf8',
  )
  await client.query(sqlText)
  invalidateTierEntitlementsCache()
  assert.equal(await can({ plan: 'solo' }, 'mfa'), true)
})
