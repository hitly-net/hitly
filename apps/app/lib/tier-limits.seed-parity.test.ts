/**
 * Seed parity (P16) + deliberate-NULL guard.
 *
 * Three sources of truth for the numeric caps must agree:
 *   1. @hitly/core TIER_LIMIT_SEED (what tests and the pure resolver use),
 *   2. the seeded INSERT inside migration 0019 (what production gets),
 *   3. the existing entitlements behaviour (completed retention must equal
 *      completedRetentionDaysForPlan / entitlementsFor; the audit windows
 *      are the fixed product values below).
 * If a value drifts between any pair, the product caps silently differ from
 * the table — which is exactly the failure the single-read-path rule is
 * meant to prevent. This file fails loudly instead.
 *
 * The NULL guard: every unlimited cap must be DELIBERATE. The allowlist
 * below is checked in both directions — a NULL not on the list fails, and a
 * listed pair that gained a number fails too (so the list cannot rot).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import {
  TIER_LIMIT_KEYS,
  TIER_LIMIT_SEED,
  WORKSPACE_PLANS,
  completedRetentionDaysForPlan,
  entitlementsForPlan,
  type WorkspacePlan,
} from '@hitly/core'

const SQL_FILE = path.join(__dirname, '../../../packages/db/drizzle/0019_curly_white_tiger.sql')

function parseSqlSeed(): Map<string, number | null> {
  const sql = readFileSync(SQL_FILE, 'utf8')
  const insert = sql.slice(sql.indexOf('INSERT INTO "tier_limits"'))
  const rows = new Map<string, number | null>()
  const re = /'([^']+)', '([^']+)', (NULL|\d+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(insert)) !== null) {
    const key = `${m[1]}|${m[2]}`
    assert.ok(!rows.has(key), `duplicate seed row for ${key} in the migration`)
    rows.set(key, m[3] === 'NULL' ? null : Number(m[3]))
  }
  return rows
}

function seedKey(plan: WorkspacePlan, key: string): string {
  return `${plan}|${key}`
}

test('P16: core seed and the migration INSERT contain the same 40 (plan,key,value) rows', () => {
  const sql = parseSqlSeed()
  assert.equal(sql.size, TIER_LIMIT_KEYS.length * WORKSPACE_PLANS.length, 'seed row count')
  for (const key of TIER_LIMIT_KEYS) {
    for (const plan of WORKSPACE_PLANS) {
      const expected = TIER_LIMIT_SEED[key][plan]
      assert.ok(sql.has(seedKey(plan, key)), `migration missing (${plan}, ${key})`)
      assert.equal(sql.get(seedKey(plan, key)), expected, `migration seed (${plan}, ${key})`)
    }
  }
})

test('P16: completed retention equals today entitlementsFor behaviour, audit equals fixed product values', () => {
  // No behaviour change at seed time: what the table says must be what the
  // product does today.
  const AUDIT_DAYS: Record<string, number> = { solo: 30, pro: 365, team: 365, enterprise: 2555 }
  for (const plan of ['solo', 'pro', 'team', 'enterprise'] as const) {
    assert.equal(TIER_LIMIT_SEED.completed_retention_days[plan], completedRetentionDaysForPlan(plan),
      `completed retention (${plan}) must equal completedRetentionDaysForPlan`)
    assert.equal(TIER_LIMIT_SEED.completed_retention_days[plan], entitlementsForPlan(plan).completedRetentionDays,
      `completed retention (${plan}) must equal entitlementsFor today`)
    assert.equal(TIER_LIMIT_SEED.audit_retention_days[plan], AUDIT_DAYS[plan], `audit retention (${plan})`)
  }
  // self-hosted (OSS) is never capped.
  assert.equal(TIER_LIMIT_SEED.completed_retention_days['self-hosted'], null)
  assert.equal(TIER_LIMIT_SEED.audit_retention_days['self-hosted'], null)
  assert.equal(completedRetentionDaysForPlan('self-hosted'), null)
})

/** Every deliberate NULL: (plan, key). Nothing may be unlimited by accident. */
const DELIBERATE_NULLS: ReadonlySet<string> = new Set<string>([
  // self-hosted: everything unlimited (OSS is never capped).
  ...TIER_LIMIT_KEYS.map((k) => `self-hosted|${k}`),
  // team is the "no seat cap" tier: seats / live projects / API keys unbounded.
  'team|seats',
  'team|live_projects',
  'team|api_keys',
  // enterprise is unlimited everywhere except api_rpm (support-deal pricing).
  'enterprise|decisions_per_month',
  'enterprise|seats',
  'enterprise|live_projects',
  'enterprise|api_keys',
  'enterprise|callback_endpoints_per_project',
])

test('every NULL cap in the seed is deliberate (both directions)', () => {
  const actualNulls = new Set<string>()
  for (const key of TIER_LIMIT_KEYS) {
    for (const plan of WORKSPACE_PLANS) {
      if (TIER_LIMIT_SEED[key][plan] === null) actualNulls.add(seedKey(plan, key))
    }
  }
  for (const pair of actualNulls) {
    assert.ok(DELIBERATE_NULLS.has(pair), `undeliberate unlimited cap: (${pair.replace('|', ', ')})`)
  }
  for (const pair of DELIBERATE_NULLS) {
    assert.ok(actualNulls.has(pair), `allowlisted NULL is no longer NULL: (${pair.replace('|', ', ')}) — remove it from the guard only if intended`)
  }
})
