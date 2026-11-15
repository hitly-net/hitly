/**
 * M1 retry policy pins + softs: Retry-After on 429 (capped 30 s), per-request
 * AbortController timeout, response body drained before a retry.
 *
 * Policy under test:
 * - non-idempotent POST (article create, KB draft create, raw POST): retry on
 *   429 ONLY; 5xx fails immediately; transport never retried.
 * - GET/PUT/PATCH/DELETE and the publish action POST: keep 429 + 5xx retries.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createZammadClient } from './client.ts'
import { ZammadApiError, ZammadTransportError } from './errors.ts'
import { MAX_RETRY_AFTER_MS, parseRetryAfterMs } from './request.ts'

const BASE_URL = 'https://zammad.example.test'
const TOKEN = 'retry-tok-91ab'

interface RecordedCall {
  url: string
  method: string
  cancels: number
}

interface FakeResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

function makeFetcher(responses: FakeResponse[]) {
  const calls: RecordedCall[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const record: RecordedCall = {
      url: String(input),
      method: String(init?.method ?? 'GET'),
      cancels: 0,
    }
    calls.push(record)
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: `status ${next.status}`,
      headers: new Headers(next.headers ?? {}),
      bodyUsed: false,
      body: {
        cancel: async () => {
          record.cancels++
        },
      },
      json: async () => next.body,
    }
  }) as unknown as typeof globalThis.fetch
  return { fn, calls }
}

function makeClient(responses: FakeResponse[], extra?: { timeoutMs?: number }) {
  const { fn, calls } = makeFetcher(responses)
  const slept: number[] = []
  const client = createZammadClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetch: fn,
    sleep: async (ms) => {
      slept.push(ms)
    },
    timeoutMs: extra?.timeoutMs,
  })
  return { client, calls, slept }
}

const ok = (body: unknown): FakeResponse => ({ status: 200, body })

// ---------------------------------------------------------------------------
// M1: non-idempotent POSTs
// ---------------------------------------------------------------------------

test('M1: POST 502 then 201 => exactly ONE POST, fails with the 502 error', async () => {
  const { client, calls } = makeClient([{ status: 502 }, { status: 201, body: { id: 1 } }])
  await assert.rejects(
    () => client.addPublicEmailReply(1, { to: 'c@example.test', body: 'b', contentType: 'text/plain' }),
    (err: unknown) => err instanceof ZammadApiError && err.status === 502 && err.method === 'POST',
  )
  assert.equal(calls.length, 1, 'customer email article must NEVER be re-sent on 5xx')
})

test('M1: internal note POST 500 => exactly ONE POST', async () => {
  const { client, calls } = makeClient([{ status: 500 }])
  await assert.rejects(() => client.addInternalNote(1, 'note'), ZammadApiError)
  assert.equal(calls.length, 1)
})

test('M1: KB draft create POST 503 => exactly ONE POST (no duplicate drafts)', async () => {
  const { client, calls } = makeClient([{ status: 503 }])
  await assert.rejects(
    () => client.kbCreateDraftAnswer(3, { categoryId: 1, title: 't', body: 'b' }),
    ZammadApiError,
  )
  assert.equal(calls.length, 1)
})

test('M1: raw POST 500 => exactly ONE POST', async () => {
  const { client, calls } = makeClient([{ status: 500 }])
  await assert.rejects(
    () => client.rawRequest('POST', '/api/v1/tickets/1/articles', { type: 'note', internal: true, body: 'x' }),
    ZammadApiError,
  )
  assert.equal(calls.length, 1)
})

test('M1: POST 429 then 201 => TWO POSTs (429 means nothing was stored)', async () => {
  const { client, calls } = makeClient([{ status: 429 }, { status: 201, body: { id: 11, ticket_id: 1 } }])
  const got = await client.addPublicEmailReply(1, { to: 'c@example.test', body: 'b', contentType: 'text/plain' })
  assert.deepEqual(got, { id: 11, ticket_id: 1 })
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.method, 'POST')
  assert.equal(calls[1]!.method, 'POST')
})

test('M1: POST 429 exhausted (always 429) => 3 POSTs then typed error', async () => {
  const { client, calls } = makeClient([{ status: 429 }])
  await assert.rejects(
    () => client.addInternalNote(1, 'x'),
    (err: unknown) => err instanceof ZammadApiError && err.status === 429,
  )
  assert.equal(calls.length, 3)
})

test('M1: transport error on POST is NOT retried (exactly one POST)', async () => {
  let posts = 0
  const counting = (async () => {
    posts++
    throw new Error('socket hang up')
  }) as unknown as typeof globalThis.fetch
  const client = createZammadClient({ baseUrl: BASE_URL, token: TOKEN, fetch: counting, sleep: async () => {} })
  await assert.rejects(
    () => client.addInternalNote(1, 'x'),
    (err: unknown) => err instanceof ZammadTransportError,
  )
  assert.equal(posts, 1)
})

// ---------------------------------------------------------------------------
// M1: idempotent methods keep 5xx retry
// ---------------------------------------------------------------------------

test('M1: GET 502 then 200 still retries (3-attempt schedule available)', async () => {
  const { client, calls } = makeClient([{ status: 502 }, ok({ id: 1 })])
  const got = await client.getTicket(1)
  assert.deepEqual(got, { id: 1 })
  assert.equal(calls.length, 2)
})

test('M1: GET 500x3 exhausts to typed 500 error', async () => {
  const { client, calls } = makeClient([{ status: 500 }])
  await assert.rejects(
    () => client.getTicket(1),
    (err: unknown) => err instanceof ZammadApiError && err.status === 500,
  )
  assert.equal(calls.length, 3)
})

test('M1: PUT 503 then 200 retries (updateTicket idempotent)', async () => {
  const { client, calls } = makeClient([{ status: 503 }, ok({ id: 7 })])
  await client.updateTicket(7, { state: 'open' })
  assert.equal(calls.length, 2)
})

test('M1: PATCH 502 then 200 retries (publisher updateLiveAnswer idempotent)', async () => {
  // covered publisher-side in publisher.test; raw PATCH here:
  const { client, calls } = makeClient([{ status: 502 }, ok({ id: 42 })])
  await client.rawRequest('PATCH', '/api/v1/tickets/7', { x: 1 })
  assert.equal(calls.length, 2)
})

// ---------------------------------------------------------------------------
// Softs: Retry-After, timeout, body drain
// ---------------------------------------------------------------------------

test('soft: Retry-After on 429 honoured for POST retry (seconds, injected sleep)', async () => {
  const { client, calls, slept } = makeClient([
    { status: 429, headers: { 'Retry-After': '7' } },
    ok({ id: 13, ticket_id: 1 }),
  ])
  await client.addInternalNote(1, 'x')
  assert.equal(calls.length, 2)
  assert.deepEqual(slept, [7000])
})

test('soft: Retry-After capped at 30 s', async () => {
  const { client, slept } = makeClient([
    { status: 429, headers: { 'Retry-After': '999' } },
    ok({ id: 13, ticket_id: 1 }),
  ])
  await client.addInternalNote(1, 'x')
  assert.deepEqual(slept, [MAX_RETRY_AFTER_MS])
})

test('soft: parseRetryAfterMs handles seconds, HTTP-date, garbage, cap', () => {
  assert.equal(parseRetryAfterMs(null), null)
  assert.equal(parseRetryAfterMs('5'), 5000)
  assert.equal(parseRetryAfterMs('0'), 0)
  assert.equal(parseRetryAfterMs('-3'), 0)
  assert.equal(parseRetryAfterMs('45'), MAX_RETRY_AFTER_MS)
  assert.equal(parseRetryAfterMs('not-a-date'), null)
  const future = new Date(Date.now() + 5000).toUTCString()
  const ms = parseRetryAfterMs(future)
  assert.ok(ms !== null && ms >= 0 && ms <= 5000)
  const past = new Date(Date.now() - 60_000).toUTCString()
  assert.equal(parseRetryAfterMs(past), 0)
})

test('soft: no Retry-After header falls back to the backoff schedule', async () => {
  const { client, slept } = makeClient([{ status: 429 }, ok({ id: 13, ticket_id: 1 })])
  await client.addInternalNote(1, 'x')
  assert.equal(slept.length, 1)
  assert.ok(slept[0]! >= 500 && slept[0]! <= 500 * 1.25 + 1)
})

test('soft: per-request timeout via AbortController -> ZammadTransportError', async () => {
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal instanceof AbortSignal, 'client must pass an AbortSignal')
    return await new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('This operation was aborted')))
    })
  }) as unknown as typeof globalThis.fetch
  const client = createZammadClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetch: hanging,
    sleep: async () => {},
    timeoutMs: 10,
  })
  await assert.rejects(
    () => client.getTicket(1),
    (err: unknown) => err instanceof ZammadTransportError && err.causeName === 'Error',
  )
})

test('soft: an AbortSignal is passed to fetch on every request', async () => {
  const seen: Array<AbortSignal | undefined> = []
  const fn = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(init?.signal ?? undefined)
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ id: 1 }),
    }
  }) as unknown as typeof globalThis.fetch
  const client = createZammadClient({ baseUrl: BASE_URL, token: TOKEN, fetch: fn, sleep: async () => {} })
  await client.getTicket(1)
  assert.equal(seen.length, 1)
  assert.ok(seen[0] instanceof AbortSignal)
})

test('soft: response body is cancelled before a retry (GET 5xx)', async () => {
  const { client, calls } = makeClient([{ status: 500 }, ok({ id: 1 })])
  await client.getTicket(1)
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.cancels, 1, 'failed response body must be drained before the retry')
  assert.equal(calls[1]!.cancels, 0)
})
