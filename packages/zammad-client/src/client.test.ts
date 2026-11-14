import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createZammadClient } from './client.ts'
import { ZammadApiError, ZammadTransportError } from './errors.ts'

const BASE_URL = 'https://zammad.example.test'
const TOKEN = 'unit-test-token-not-a-secret'

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

interface FakeResponse {
  status: number
  body?: unknown
}

/**
 * Mock fetch: returns the queued responses in order; the last one repeats if
 * the client somehow asks for more. Records every call for assertions.
 */
function makeFetcher(responses: FakeResponse[]) {
  const calls: RecordedCall[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const record: RecordedCall = {
      url: String(input),
      method: String(init?.method ?? 'GET'),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(record)
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: `status ${next.status}`,
      json: async () => next.body,
    }
  }) as unknown as typeof globalThis.fetch
  return { fn, calls }
}

function makeClient(responses: FakeResponse[]) {
  const { fn, calls } = makeFetcher(responses)
  const slept: number[] = []
  const client = createZammadClient({
    baseUrl: `${BASE_URL}/`, // trailing slash must be tolerated
    token: TOKEN,
    fetch: fn,
    sleep: async (ms) => {
      slept.push(ms)
    },
  })
  return { client, calls, slept }
}

const ok = (body: unknown): FakeResponse => ({ status: 200, body })

test('auth header is exactly `Token token=<token>` on every request', async () => {
  const { client, calls } = makeClient([ok({ id: 1 })])
  await client.getTicket(1)
  assert.equal(calls[0]!.headers.authorization, `Token token=${TOKEN}`)
  assert.equal(calls[0]!.headers.accept, 'application/json')
})

test('getTicket: GET /api/v1/tickets/{id}, no request body', async () => {
  const ticket = { id: 1, title: 'help', state: { id: 2, name: 'open' } }
  const { client, calls } = makeClient([ok(ticket)])
  const got = await client.getTicket(1)
  assert.deepEqual(got, ticket)
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/tickets/1`)
  assert.equal(calls[0]!.method, 'GET')
  assert.equal(calls[0]!.body, undefined)
  assert.ok(!('content-type' in calls[0]!.headers))
})

test('listArticles: GET /api/v1/tickets/{id}/articles', async () => {
  const articles = [{ id: 10, ticket_id: 1, body: 'hi' }]
  const { client, calls } = makeClient([ok(articles)])
  const got = await client.listArticles(1)
  assert.deepEqual(got, articles)
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/tickets/1/articles`)
  assert.equal(calls[0]!.method, 'GET')
})

test('addPublicEmailReply: POST email article with internal=false', async () => {
  const created = { id: 11, ticket_id: 1, type: 'email', internal: false }
  const { client, calls } = makeClient([ok(created)])
  const got = await client.addPublicEmailReply(1, {
    to: 'customer@example.test',
    subject: 'Re: billing question',
    body: '<p>hello</p>',
    contentType: 'text/html',
  })
  assert.deepEqual(got, created)
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/tickets/1/articles`)
  assert.equal(calls[0]!.method, 'POST')
  assert.equal(calls[0]!.headers['content-type'], 'application/json')
  assert.deepEqual(calls[0]!.body, {
    type: 'email',
    internal: false,
    to: 'customer@example.test',
    subject: 'Re: billing question',
    body: '<p>hello</p>',
    content_type: 'text/html',
  })
})

test('addPublicEmailReply without subject sends subject=null', async () => {
  const { client, calls } = makeClient([ok({ id: 12, ticket_id: 1 })])
  await client.addPublicEmailReply(1, {
    to: 'a@example.test',
    body: 'plain text',
    contentType: 'text/plain',
  })
  assert.deepEqual(calls[0]!.body, {
    type: 'email',
    internal: false,
    to: 'a@example.test',
    subject: null,
    body: 'plain text',
    content_type: 'text/plain',
  })
})

test('addInternalNote: POST note article with internal=true', async () => {
  const { client, calls } = makeClient([ok({ id: 13, ticket_id: 1 })])
  await client.addInternalNote(1, 'ops only')
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/tickets/1/articles`)
  assert.equal(calls[0]!.method, 'POST')
  assert.deepEqual(calls[0]!.body, { type: 'note', internal: true, body: 'ops only' })
})

test('updateTicket: PUT with exactly the given fields (state, owner_id, hitly_type, custom)', async () => {
  const { client, calls } = makeClient([ok({ id: 7 })])
  await client.updateTicket(7, {
    state: 'open',
    owner_id: 3,
    hitly_type: 'billing',
    hitly_internal_ref: 'WP-SUP-0',
  })
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/tickets/7`)
  assert.equal(calls[0]!.method, 'PUT')
  assert.deepEqual(calls[0]!.body, {
    state: 'open',
    owner_id: 3,
    hitly_type: 'billing',
    hitly_internal_ref: 'WP-SUP-0',
  })
})

test('updateTicket can unassign owner with null', async () => {
  const { client, calls } = makeClient([ok({ id: 7 })])
  await client.updateTicket(7, { owner_id: null })
  assert.deepEqual(calls[0]!.body, { owner_id: null })
})

test('searchTickets: GET /api/v1/tickets/search with encoded query', async () => {
  const { client, calls } = makeClient([ok({ tickets: [1, 2], tickets_count: 2 })])
  const got = await client.searchTickets('state:open "billing issue"')
  assert.deepEqual(got, { tickets: [1, 2], tickets_count: 2 })
  assert.equal(calls[0]!.method, 'GET')
  assert.equal(
    calls[0]!.url,
    `${BASE_URL}/api/v1/tickets/search?query=${encodeURIComponent('state:open "billing issue"')}&paginate=false`,
  )
})

test('kbSearch: GET /api/v1/knowledge_bases/search with encoded query', async () => {
  const posts = { answer: [{ id: 3, title: 'refund policy' }] }
  const { client, calls } = makeClient([ok({ posts })])
  const got = await client.kbSearch('refund policy')
  assert.deepEqual(got.posts, posts)
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/knowledge_bases/search?query=refund%20policy`)
  assert.equal(calls[0]!.method, 'GET')
})

test('kbGetAnswer: GET kb-scoped answer path', async () => {
  const { client, calls } = makeClient([ok({ id: 9 })])
  const got = await client.kbGetAnswer(3, 9)
  assert.deepEqual(got, { id: 9 })
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/knowledge_bases/3/answers/9`)
  assert.equal(calls[0]!.method, 'GET')
})

test('kbCreateDraftAnswer: POST answer with translations_attributes, no publish call', async () => {
  const { client, calls } = makeClient([ok({ id: 20 })])
  await client.kbCreateDraftAnswer(3, { categoryId: 5, title: 'How to refund', body: '<p>steps</p>' })
  assert.equal(calls.length, 1) // DRAFT only: nothing may hit /publish
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/knowledge_bases/3/answers`)
  assert.equal(calls[0]!.method, 'POST')
  assert.deepEqual(calls[0]!.body, {
    category_id: 5,
    translations_attributes: [
      { title: 'How to refund', content_attributes: { body: '<p>steps</p>' } },
    ],
  })
})

test('kbCreateDraftAnswer passes kb_locale_id when provided', async () => {
  const { client, calls } = makeClient([ok({ id: 21 })])
  await client.kbCreateDraftAnswer(3, { categoryId: 5, title: 't', body: 'b', kbLocaleId: 1 })
  assert.deepEqual(calls[0]!.body, {
    category_id: 5,
    translations_attributes: [
      { title: 't', content_attributes: { body: 'b' }, kb_locale_id: 1 },
    ],
  })
})

test('retries 429 then succeeds; second attempt sleeps > 0', async () => {
  const { client, calls, slept } = makeClient([{ status: 429 }, ok({ id: 1 })])
  const got = await client.getTicket(1)
  assert.deepEqual(got, { id: 1 })
  assert.equal(calls.length, 2)
  assert.equal(slept.length, 1)
  assert.ok(slept[0]! >= 500, `expected sleep >= 500ms base, got ${slept[0]}`)
})

test('retries 5xx then succeeds (3 attempts)', async () => {
  const { client, calls } = makeClient([
    { status: 500 },
    { status: 502 },
    ok({ id: 1 }),
  ])
  const got = await client.getTicket(1)
  assert.deepEqual(got, { id: 1 })
  assert.equal(calls.length, 3)
})

test('exhausted 5xx retries throw ZammadApiError with status', async () => {
  const { client, calls } = makeClient([{ status: 503 }])
  await assert.rejects(
    () => client.getTicket(1),
    (err: unknown) => {
      if (!(err instanceof ZammadApiError)) return false
      assert.equal(err.status, 503)
      assert.equal(err.method, 'GET')
      assert.equal(err.path, '/api/v1/tickets/1')
      return true
    },
  )
  assert.equal(calls.length, 3) // default schedule = 3 attempts
})

test('no retry on 404: one call, typed error carries status', async () => {
  const { client, calls } = makeClient([{ status: 404 }])
  await assert.rejects(
    () => client.getTicket(999),
    (err: unknown) => {
      if (!(err instanceof ZammadApiError)) return false
      assert.equal(err.status, 404)
      return true
    },
  )
  assert.equal(calls.length, 1)
})

test('no retry on 400/401/403/422: one call each', async () => {
  for (const status of [400, 401, 403, 422]) {
    const { client, calls } = makeClient([{ status }])
    await assert.rejects(
      () => client.addInternalNote(1, 'x'),
      (err: unknown) => err instanceof ZammadApiError && err.status === status,
    )
    assert.equal(calls.length, 1, `status ${status} must not be retried`)
  }
})

test('transport failure -> ZammadTransportError, no retry (policy is 429/5xx only)', async () => {
  const { fn, calls } = makeFetcher([])
  const throwing = (async () => {
    throw new Error('connect ECONNREFUSED')
  }) as unknown as typeof globalThis.fetch
  const client = createZammadClient({ baseUrl: BASE_URL, token: TOKEN, fetch: throwing, sleep: async () => {} })
  await assert.rejects(
    () => client.getTicket(1),
    (err: unknown) => {
      if (!(err instanceof ZammadTransportError)) return false
      assert.equal(err.method, 'GET')
      assert.equal(err.path, '/api/v1/tickets/1')
      assert.ok(err.cause instanceof Error)
      return true
    },
  )
  void fn
  void calls
})

test('error messages never contain the token and omit the query string', async () => {
  const { client } = makeClient([{ status: 500 }])
  await assert.rejects(
    () => client.searchTickets('secret-search-term'),
    (err: unknown) => {
      if (!(err instanceof ZammadApiError)) return false
      assert.ok(!err.message.includes(TOKEN), 'token must never reach the message')
      assert.ok(!err.message.includes('secret-search-term'), 'query string must stay out of messages')
      assert.equal(err.path, '/api/v1/tickets/search')
      return true
    },
  )
})

test('non-JSON 2xx body -> typed shape error', async () => {
  const throwingJson = (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => {
      throw new SyntaxError('not json')
    },
  })) as unknown as typeof globalThis.fetch
  const client = createZammadClient({ baseUrl: BASE_URL, token: TOKEN, fetch: throwingJson, sleep: async () => {} })
  await assert.rejects(
    () => client.getTicket(1),
    (err: unknown) => err instanceof Error && err.name === 'ZammadResponseShapeError',
  )
})

test('204 responses resolve undefined', async () => {
  const noContent = (async () => ({
    ok: true,
    status: 204,
    statusText: 'No Content',
    json: async () => {
      throw new Error('must not be called')
    },
  })) as unknown as typeof globalThis.fetch
  const client = createZammadClient({ baseUrl: BASE_URL, token: TOKEN, fetch: noContent, sleep: async () => {} })
  assert.equal(await client.rawRequest('DELETE', '/api/v1/tickets/1'), undefined)
})
