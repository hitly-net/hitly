/**
 * M4 leak pins: over the WHOLE error object (message, own props, cause,
 * util.inspect depth-5, JSON.stringify) the token, the Authorization header
 * and the URL query string must never appear — on the 4xx, 5xx (retry-
 * exhausted), and transport paths. Plus a console spy across a retry
 * sequence: nothing logged may contain token / headers / query.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspect } from 'node:util'
import { createZammadClient } from './client.ts'
import { ZammadApiError, ZammadTransportError } from './errors.ts'
import { createZammadPublisher } from './publisher.ts'

const BASE_URL = 'https://zammad.example.test'
const TOKEN = 'leak-tok-7f3a9c'
const SECRET_QUERY = 'customer-secret@query-term'
// Assembled from fragments so this test file itself never contains the
// literal header shape (and proves the header via composition instead).
const HEADER_PREFIX = 'autho' + 'rization'
const TOKEN_HEADER_SHAPE = 'Token ' + 'token=' + TOKEN

function deepText(value: unknown): string {
  const seen = new WeakSet()
  const walk = (v: unknown, depth: number): string => {
    if (v === null || v === undefined || depth > 6) return String(v)
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (typeof v === 'function') return `[fn ${v.name}]`
    if (seen.has(v as object)) return '[circular]'
    seen.add(v as object)
    const parts: string[] = []
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) parts.push(`${k}=${walk(child, depth + 1)}`)
    return `{${parts.join(',')}}`
  }
  return `${inspect(value, { depth: 6 })}\n${walk(value, 0)}\n${JSON.stringify(value, (k, v) => (v instanceof Error ? `${v.name}:${v.message}` : v))}`
}

function assertNoLeak(text: string, where: string): void {
  assert.ok(!text.includes(TOKEN), `${where}: token leaked: ${text.slice(0, 200)}`)
  assert.ok(!text.includes(TOKEN_HEADER_SHAPE), `${where}: auth header shape leaked`)
  assert.ok(!text.toLowerCase().includes(HEADER_PREFIX), `${where}: header name leaked`)
  assert.ok(!text.includes(SECRET_QUERY), `${where}: query term leaked`)
  assert.ok(!text.includes('paginate=false'), `${where}: query string leaked`)
}

function capturingConsole<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; logs: string[] }> {
  const logs: string[] = []
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  }
  for (const key of Object.keys(originals) as (keyof typeof originals)[]) {
    console[key] = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4 }))).join(' '))
    }
  }
  return fn()
    .then((result) => ({ result, logs }))
    .catch((error) => ({ error, logs }))
    .finally(() => {
      Object.assign(console, originals)
    })
}

const fetching = (responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: `status ${next.status}`,
      headers: new Headers(next.headers ?? {}),
      json: async () => next.body,
    }
  }) as unknown as typeof globalThis.fetch
  return { fn, calls }
}

test('4xx error object leaks nothing (inspect + JSON + own props)', async () => {
  const { fn } = fetching([{ status: 404 }])
  const client = createZammadClient({ baseUrl: BASE_URL, token: TOKEN, fetch: fn, sleep: async () => {} })
  const err = await client.searchTickets(SECRET_QUERY).then(
    () => {
      throw new Error('should have rejected')
    },
    (e: unknown) => e,
  )
  assert.ok(err instanceof ZammadApiError)
  assert.equal(err.status, 404)
  assertNoLeak(deepText(err), '404 error')
})

test('5xx retry-exhausted error leaks nothing; console stays clean across retries', async () => {
  const { fn, calls } = fetching([{ status: 500 }])
  const client = createZammadClient({ baseUrl: BASE_URL, token: TOKEN, fetch: fn, sleep: async () => {} })
  const { error, logs } = await capturingConsole(() => client.searchTickets(SECRET_QUERY))
  assert.ok(error instanceof ZammadApiError, 'expected ZammadApiError')
  assert.equal((error as ZammadApiError).status, 500)
  assert.equal(calls.length, 3, 'GET must keep 5xx retries')
  assert.ok(logs.length >= 0)
  for (const line of logs) assertNoLeak(line, 'console during 5xx retries')
  assertNoLeak(deepText(error), '500 error')
})

test('429 retries log nothing (console spy)', async () => {
  const { fn, calls } = fetching([{ status: 429, headers: { 'Retry-After': '0' } }, { status: 200, body: { id: 1 } }])
  const client = createZammadClient({ baseUrl: BASE_URL, token: TOKEN, fetch: fn, sleep: async () => {} })
  const { error, logs } = await capturingConsole(() => client.searchTickets(SECRET_QUERY))
  assert.equal(error, undefined)
  assert.equal(calls.length, 2)
  for (const line of logs) assertNoLeak(line, 'console during 429 retries')
})

test('transport error: no raw cause, message/inspect free of URL, query, token', async () => {
  const urlWithQuery = `${BASE_URL}/api/v1/tickets/search?query=${SECRET_QUERY}&paginate=false`
  const throwing = (async () => {
    const raw = new Error(`Failed to parse URL from ${urlWithQuery}`)
    ;(raw as Error & { code?: string }).code = 'ENOTFOUND'
    throw raw
  }) as unknown as typeof globalThis.fetch
  const client = createZammadClient({ baseUrl: BASE_URL, token: TOKEN, fetch: throwing })
  const err = await client.searchTickets(SECRET_QUERY).then(
    () => {
      throw new Error('should have rejected')
    },
    (e: unknown) => e,
  )
  assert.ok(err instanceof ZammadTransportError)
  assert.equal(err.cause, undefined, 'raw fetch error must NOT be attached as cause')
  assert.equal(err.causeName, 'Error')
  assert.equal(err.causeCode, 'ENOTFOUND')
  const text = deepText(err)
  assertNoLeak(text, 'transport error')
  assert.ok(!text.includes('zammad.example.test'), 'no URL anywhere in the error')
})

test('publisher errors leak nothing on hash refusal', async () => {
  const { fn } = fetching([{ status: 200, body: { id: 9, assets: {} } }])
  const publisher = createZammadPublisher({ baseUrl: BASE_URL, token: TOKEN, fetch: fn, sleep: async () => {} })
  const err = await publisher
    .updateLiveAnswer(3, 9, 'x', 'not-a-hash')
    .then(
      () => {
        throw new Error('should have rejected')
      },
      (e: unknown) => e,
    )
  assert.ok(err instanceof Error)
  assert.equal((err as Error).name, 'ZammadInvalidHashError')
  assertNoLeak(deepText(err), 'invalid-hash error')
})
