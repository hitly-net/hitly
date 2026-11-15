/**
 * Entry-point guard (M2): the main export of @hitly/zammad-client must NEVER
 * expose publishing or live KB-answer editing — not via method names, not
 * via rawRequest, not via the package.json exports map. If a test here goes
 * red, someone widened the safe surface — move it back to the publisher.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as mainEntry from './index.ts'
import * as publisherEntry from './publisher.ts'
import { createZammadClient } from './client.ts'
import { ZammadKbWriteGuardError } from './errors.ts'

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

const neverFetch = (async () => {
  throw new Error('must not fetch')
}) as unknown as typeof globalThis.fetch

function safeClient(fetch: typeof globalThis.fetch = neverFetch) {
  return createZammadClient({ baseUrl: 'https://zammad.example.test', token: 'x', fetch, sleep: async () => {} })
}

/** The COMPLETE method surface of the safe client — extend deliberately. */
const SAFE_CLIENT_METHODS = [
  'addInternalNote',
  'addPublicEmailReply',
  'getTicket',
  'kbCreateDraftAnswer',
  'kbGetAnswer',
  'kbSearch',
  'listArticles',
  'rawRequest',
  'searchTickets',
  'updateTicket',
]

/** The COMPLETE runtime export list of the main entry (E7 killer: a renamed
 * publish export like `goLive` lands here and fails the deepEqual). */
const MAIN_ENTRY_EXPORTS = [
  'DEFAULT_BACKOFF_MS',
  'DEFAULT_TIMEOUT_MS',
  'MAX_RETRY_AFTER_MS',
  'SUPPORT_TICKET_TYPES',
  'ZammadApiError',
  'ZammadKbWriteGuardError',
  'ZammadResponseShapeError',
  'ZammadTransportError',
  'createZammadClient',
  'isRetryableStatus',
  'isSupportTicketType',
  'supportTicketTypeOptions',
]

/** The COMPLETE runtime export list of the publisher entry. */
const PUBLISHER_ENTRY_EXPORTS = [
  'ZammadConflictError',
  'ZammadHashMismatchError',
  'ZammadInvalidHashError',
  'createZammadPublisher',
  'normalizeContentHash',
  'sha256Hex',
]

// ---------------------------------------------------------------------------
// Exports map (E4/E5/E6 killers)
// ---------------------------------------------------------------------------

test('package.json exports map is EXACTLY . and ./publisher (no wildcards, no ./admin, no ./src/*)', () => {
  const pkg = JSON.parse(read('../package.json')) as { exports?: Record<string, string> }
  assert.deepEqual(pkg.exports, {
    '.': './src/index.ts',
    './publisher': './src/publisher.ts',
  })
})

// ---------------------------------------------------------------------------
// Main-entry export surface (E7 killer)
// ---------------------------------------------------------------------------

test('main entry runtime exports are EXACTLY the allowlist (renamed publish exports fail here)', () => {
  assert.deepEqual(Object.keys(mainEntry).sort(), [...MAIN_ENTRY_EXPORTS].sort())
})

test('publisher entry runtime exports are EXACTLY the allowlist (positive control)', () => {
  assert.deepEqual(Object.keys(publisherEntry).sort(), [...PUBLISHER_ENTRY_EXPORTS].sort())
})

test('main entry has no publish/live-edit names; publisher does', () => {
  for (const forbidden of ['publishAnswer', 'updateLiveAnswer', 'createZammadPublisher', 'sha256Hex', 'normalizeContentHash']) {
    assert.ok(!(forbidden in mainEntry), `main entry must not export ${forbidden}`)
  }
  const publisher = publisherEntry.createZammadPublisher({
    baseUrl: 'https://zammad.example.test',
    token: 'x',
    fetch: neverFetch,
  })
  assert.equal(typeof publisher.publishAnswer, 'function')
  assert.equal(typeof publisher.updateLiveAnswer, 'function')
})

test('safe client method surface is EXACTLY the allowlist (deepEqual pin)', () => {
  assert.deepEqual(Object.keys(safeClient()).sort(), [...SAFE_CLIENT_METHODS].sort())
})

test('no method name on the safe client smells of publish/live-edit', () => {
  for (const name of Object.keys(safeClient())) {
    assert.ok(!/publish/i.test(name), `safe client must not grow a publish-like method: ${name}`)
    assert.ok(!/updateLiveAnswer|editAnswer|updateAnswer|goLive/i.test(name), `safe client must not grow a live-answer-edit method: ${name}`)
  }
})

// ---------------------------------------------------------------------------
// rawRequest confinement (main client cannot reach /publish or answer writes)
// ---------------------------------------------------------------------------

async function expectGuarded(fetch: typeof globalThis.fetch, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string) {
  const client = safeClient(fetch)
  await assert.rejects(
    () => client.rawRequest(method, path),
    (err: unknown) => err instanceof ZammadKbWriteGuardError && err.method === method && err.path === path,
  )
}

test('rawRequest cannot POST the publish action (no fetch made)', async () => {
  let fetches = 0
  const counting = (async () => {
    fetches++
    return { ok: true, status: 200, json: async () => ({}) }
  }) as unknown as typeof globalThis.fetch
  await expectGuarded(counting, 'POST', '/api/v1/knowledge_bases/1/answers/2/publish')
  assert.equal(fetches, 0, 'guard must refuse BEFORE any network call')
})

test('rawRequest cannot PATCH/PUT/POST/DELETE KB answer paths (no fetch made)', async () => {
  let fetches = 0
  const counting = (async () => {
    fetches++
    return { ok: true, status: 200, json: async () => ({}) }
  }) as unknown as typeof globalThis.fetch
  await expectGuarded(counting, 'PATCH', '/api/v1/knowledge_bases/1/answers/2')
  await expectGuarded(counting, 'PUT', '/api/v1/knowledge_bases/1/answers/2')
  await expectGuarded(counting, 'POST', '/api/v1/knowledge_bases/1/answers')
  await expectGuarded(counting, 'DELETE', '/api/v1/knowledge_bases/1/answers/2')
  await expectGuarded(counting, 'POST', '/api/v1/knowledge_bases/1/answers/2/internal')
  await expectGuarded(counting, 'POST', '/api/v1/knowledge_bases/1/answers/2/archive')
  await expectGuarded(counting, 'POST', '/api/v1/knowledge_bases/answers/2/publish')
  assert.equal(fetches, 0)
})

test('rawRequest CAN still read KB answers and write non-KB paths', async () => {
  const calls: string[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 1 }) }
  }) as unknown as typeof globalThis.fetch
  const client = safeClient(fn)
  await client.rawRequest('GET', '/api/v1/knowledge_bases/1/answers/2')
  await client.rawRequest('POST', '/api/v1/tickets/5/articles', { type: 'note' })
  await client.rawRequest('PUT', '/api/v1/tickets/5', { state: 'open' })
  await client.rawRequest('GET', '/api/v1/object_manager_attributes?object=Ticket')
  assert.equal(calls.length, 4)
})

test('publisher.rawRequest (inherited from the safe client) is ALSO confined; typed publisher methods unaffected in surface', async () => {
  const publisher = publisherEntry.createZammadPublisher({
    baseUrl: 'https://zammad.example.test',
    token: 'x',
    fetch: neverFetch,
  })
  await assert.rejects(
    () => publisher.rawRequest('POST', '/api/v1/knowledge_bases/1/answers/2/publish'),
    ZammadKbWriteGuardError,
  )
})

// ---------------------------------------------------------------------------
// Source scans
// ---------------------------------------------------------------------------

test('source scan: index.ts never mentions the restricted names or imports publisher', () => {
  const source = read('./index.ts')
  for (const forbidden of ['publishAnswer', 'updateLiveAnswer', 'createZammadPublisher', './publisher']) {
    assert.ok(!source.includes(forbidden), `index.ts must not contain ${forbidden}`)
  }
})

test('source scan: no main-path module (client/request/types/errors/ticket-types) defines the restricted functions', () => {
  for (const file of ['./client.ts', './request.ts', './types.ts', './errors.ts', './ticket-types.ts']) {
    const source = read(file)
    for (const name of ['publishAnswer', 'updateLiveAnswer', 'createZammadPublisher', 'goLive']) {
      assert.ok(!new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(source), `${file} must not export function ${name}`)
    }
  }
})

test('source scan: publisher.ts is the only home of the restricted functions', () => {
  const source = read('./publisher.ts')
  assert.match(source, /async publishAnswer\(/)
  assert.match(source, /async updateLiveAnswer\(/)
})

test('package is self-contained: no @hitly imports anywhere in src or scripts', () => {
  const importShape = /(from\s+|import\s+|require\(\s*)['"]@hitly\//
  for (const file of ['./index.ts', './client.ts', './publisher.ts', './request.ts', './types.ts', './errors.ts', './ticket-types.ts', './entry-guards.test.ts', './client.test.ts', './publisher.test.ts', './retry-policy.test.ts', './leak.test.ts', './ticket-types.test.ts', '../scripts/setup-hitly-type-field.ts', '../scripts/setup-hitly-type-field.test.ts']) {
    const source = read(file)
    assert.ok(!importShape.test(source), `${file} must not import any @hitly workspace package`)
  }
  const pkg = JSON.parse(read('../package.json')) as { dependencies?: Record<string, string> }
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies (self-contained)')
})
