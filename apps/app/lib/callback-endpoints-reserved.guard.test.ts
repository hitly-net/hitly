/**
 * hitly#181 C14: callback_endpoints_per_project is reserved and unwired.
 *
 * There is no persisted callback-endpoint table or write path on main or on
 * #175 (HTTP callbacks are a per-request resumeUrl at ingest). This guard
 * pins the seed and fails if a production write path starts consulting the
 * key without the enforcement tests in the #181 contract (C14b–C14d).
 *
 * If you wire a real chokepoint, delete or replace this file and add those
 * enforcement tests. Do not invent an endpoint manager just to make a cap
 * look enforced.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { TIER_LIMIT_SEED } from '@hitly/core'

const ROOT = path.join(__dirname, '../../..')
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  'drizzle',
  '.git',
  '.turbo',
  'android',
  'ios',
  'Pods',
])

const GATE_CALL = /(?:checkQuota|assertGate|gateApiKey|gateCallback|assertCallback|gate\()\s*\([^;]{0,400}callback_endpoints_per_project/

function* walk(dir: string): Generator<string> {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(path.join(dir, entry.name))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      yield path.join(dir, entry.name)
    }
  }
}

test('seed values for callback_endpoints_per_project are the published caps', () => {
  assert.deepEqual(TIER_LIMIT_SEED.callback_endpoints_per_project, {
    'self-hosted': null,
    solo: 1,
    pro: 3,
    team: 10,
    enterprise: null,
  })
})

test('no production write path consults callback_endpoints_per_project', () => {
  const hits: string[] = []
  for (const root of ['apps', 'packages']) {
    for (const file of walk(path.join(ROOT, root))) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('callback_endpoints_per_project')) continue
      if (GATE_CALL.test(text)) hits.push(path.relative(ROOT, file))
    }
  }
  assert.deepEqual(
    hits,
    [],
    `callback_endpoints_per_project is reserved/unwired. If you wired a write path, replace this pin with C14b–C14d enforcement tests. Hits: ${hits.join(', ')}`,
  )
})

test('ENFORCED_TIER_LIMIT_KEYS (when present) does not claim callback enforcement', async () => {
  let enforced: readonly string[] | undefined
  try {
    const mod = await import('./tier-limit-result')
    enforced = mod.ENFORCED_TIER_LIMIT_KEYS
  } catch {
    try {
      const mod = await import('./tier-enforcement')
      enforced = mod.ENFORCED_TIER_LIMIT_KEYS
    } catch {
      // Bare main has no #175 module: nothing claims enforcement.
      return
    }
  }
  assert.ok(enforced, 'enforced key list should be an array when the module exists')
  assert.equal(
    (enforced as readonly string[]).includes('callback_endpoints_per_project'),
    false,
    'do not add callback_endpoints_per_project to ENFORCED_TIER_LIMIT_KEYS while the write path is unwired',
  )
})
