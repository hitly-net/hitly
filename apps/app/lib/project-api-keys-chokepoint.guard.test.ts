/**
 * hitly#181 C8: the only production writer of projectApiKeys is
 * insertNewProjectApiKey, and that chokepoint must consult the api_keys
 * cap before the insert. The web action must convert TierLimitError the
 * same way createProject does.
 *
 * Fails on current main and on #175 because the chokepoint does not mention
 * api_keys and createProjectApiKey does not call toTierLimitBlockedResult.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

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

const ALLOW_INSERT = [
  /apps[/\\]app[/\\]lib[/\\]project-create\.ts$/,
  /apps[/\\]app[/\\]lib[/\\]m0h-fixture\.ts$/,
]

const INSERT_RE = /insert\s*\(\s*projectApiKeys\b|\.insert\s*\(\s*projectApiKeys\b|insert\s+into\s+project_api_keys/i

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

function allowed(file: string): boolean {
  return ALLOW_INSERT.some((re) => re.test(file))
}

function extractFunction(src: string, name: string): string {
  const start = src.search(new RegExp(`export async function ${name}\\s*\\(`))
  assert.ok(start >= 0, `expected export async function ${name}`)
  // Brace match from the first '{' after the signature.
  const brace = src.indexOf('{', start)
  assert.ok(brace >= 0, `expected body for ${name}`)
  let depth = 0
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return src.slice(start)
}

test('only insertNewProjectApiKey (and the test fixture) inserts projectApiKeys in production sources', () => {
  const hits: string[] = []
  for (const root of ['apps', 'packages']) {
    for (const file of walk(path.join(ROOT, root))) {
      const text = readFileSync(file, 'utf8')
      if (!INSERT_RE.test(text)) continue
      if (allowed(file)) continue
      hits.push(path.relative(ROOT, file))
    }
  }
  assert.deepEqual(hits, [], `unexpected projectApiKeys writers: ${hits.join(', ')}`)
})

test('insertNewProjectApiKey consults the api_keys cap before the insert', () => {
  const src = readFileSync(path.join(ROOT, 'apps/app/lib/project-create.ts'), 'utf8')
  const body = extractFunction(src, 'insertNewProjectApiKey')
  const insertAt = body.search(/insert\s*\(\s*projectApiKeys\b/)
  assert.ok(insertAt >= 0, 'insertNewProjectApiKey must still insert projectApiKeys')
  const before = body.slice(0, insertAt)
  const mentionsKey =
    /\bapi_keys\b/.test(before) ||
    /\bassertApiKey\b/.test(before) ||
    /\bgateApiKey\b/.test(before) ||
    /\bassertGate\s*\([^)]*api_keys/.test(before)
  assert.ok(
    mentionsKey,
    'insertNewProjectApiKey must consult the api_keys limit (assertApiKey / gateApiKey / checkQuota(..., "api_keys") or equivalent) before inserting',
  )
})

test('createProjectApiKey converts TierLimitError the same way createProject does', () => {
  const src = readFileSync(path.join(ROOT, 'apps/app/actions/projects.ts'), 'utf8')
  const createProject = extractFunction(src, 'createProject')
  const createKey = extractFunction(src, 'createProjectApiKey')
  assert.match(createProject, /toTierLimitBlockedResult/, 'createProject is the vocabulary to reuse')
  assert.match(
    createKey,
    /toTierLimitBlockedResult/,
    'createProjectApiKey must convert TierLimitError with toTierLimitBlockedResult after the tenant transaction has rolled back',
  )
})
