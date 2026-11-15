/**
 * Guard: no hard-coded tier checks may come back.
 *
 * Every boolean feature gate must read the tier_entitlements DB table
 * through the single helper `can(workspace, feature)`
 * (apps/app/lib/tier-entitlements.ts). This test walks all production
 * TypeScript/TSX sources and fails on:
 *
 *   - a plan-name comparison (`plan === 'team'`, `plan !== 'enterprise'`, …)
 *   - the legacy edition feature gate (hasFeature/requireFeature/
 *     FeatureUnavailableError/entitlements.features)
 *   - direct queries of the tier_entitlements table outside the helper
 *
 * Test files and the map's own definition sites (feature registry, schema,
 * migrations) are exempt — the registry names plans as data, which is the
 * point; what must never return is branch logic on a plan name.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const ROOT = path.join(__dirname, '../../..')

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  'drizzle', // generated migrations (seed data, not checks)
  '.git',
  '.turbo',
  'android',
  'ios',
  'Pods',
])

/** Production sources under these roots are scanned. */
const SCAN_ROOTS = ['apps', 'packages']

type Rule = { name: string; pattern: RegExp; allow?: RegExp }

const RULES: Rule[] = [
  {
    name: 'plan-name comparison',
    // `plan === 'team'`, `plan !== 'enterprise'`, `plan == 'solo'` — but not
    // `plan: 'solo'` (object literal data) nor min_plan column SQL.
    pattern: /\bplan\s*[!=]==?\s*['"]/,
  },
  { name: 'legacy hasFeature gate', pattern: /\bhasFeature\s*\(/ },
  { name: 'legacy requireFeature gate', pattern: /\brequireFeature\s*\(/ },
  { name: 'legacy FeatureUnavailableError', pattern: /\bFeatureUnavailableError\b/ },
  { name: 'edition feature booleans', pattern: /\bentitlements\.features\b/ },
  {
    name: 'direct tier_entitlements table use',
    pattern: /\btierEntitlements\b/,
    allow: /apps[/\\]app[/\\]lib[/\\]tier-entitlements\.ts$|packages[/\\]db[/\\]src[/\\]schema\.ts$/,
  },
]

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

test('no hard-coded tier checks outside the entitlements map', () => {
  const violations: string[] = []
  let scanned = 0
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(ROOT, root))) {
      scanned += 1
      const text = readFileSync(file, 'utf8')
      for (const rule of RULES) {
        if (rule.allow?.test(file)) continue
        const line = text.split('\n').findIndex((l) => rule.pattern.test(l))
        if (line >= 0) {
          violations.push(`${path.relative(ROOT, file)}:${line + 1} ${rule.name}: ${text.split('\n')[line].trim()}`)
        }
      }
    }
  }
  // Sanity: the walk must actually see the monorepo.
  assert.ok(scanned > 100, `guard walked only ${scanned} files — path resolution broken?`)
  assert.deepEqual(violations, [], 'hard-coded tier checks found; route them through can()')
})

test('the helper and the registry exist where the guard expects them', () => {
  // If someone moves the helper, the direct-use allowlist above would
  // wrongly exempt nothing; fail loudly instead of silently.
  statSync(path.join(ROOT, 'apps/app/lib/tier-entitlements.ts'))
  statSync(path.join(ROOT, 'packages/core/src/tier-entitlements.ts'))
  const helper = readFileSync(path.join(ROOT, 'apps/app/lib/tier-entitlements.ts'), 'utf8')
  assert.match(helper, /export async function can\(/)
  assert.match(helper, /canFromMap/)
})
