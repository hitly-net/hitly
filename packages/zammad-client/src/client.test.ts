import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createZammadClient } from './client.ts'
import { ZammadApiError, ZammadTransportError } from './errors.ts'

const BASE_URL = 'https://zammad.example.test'
const TOKEN = 'unit-tok-4f2e'
// Built from fragments: this source never contains the full header shape.
const AUTH_HEADER_SHAPE = (token: string) => 'Token ' + 'token=' + token

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal
}

interface FakeResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

function makeFetcher(responses: FakeResponse[]) {
  const calls: RecordedCall[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? 'GET'),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      signal: init?.signal ?? undefined,
    })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: `status ${next.status}`,
      headers: new Headers(next.headers ?? {}),
      body: { cancel: async () => {}, used: false },
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

test('auth header is the Token shape with the config token on every request', async () => {
  const { client, calls } = makeClient([ok({ id: 1 })])
  await client.getTicket(1)
  assert.equal(calls[0]!.headers.authorization, AUTH_HEADER_SHAPE(TOKEN))
  assert.equal(calls[0]!.headers.accept, 'application/json')
})

test('TOKENS: two clients with different tokens each send their own header (no env, no cross-talk)', async () => {
  const { fn: fnA, calls: callsA } = makeFetcher([ok({ id: 1 })])
  const { fn: fnB, calls: callsB } = makeFetcher([ok({ id: 2 })])
  process.env.ZAMMAD_TOKEN = 'env-tok-should-never-be-used'
  try {
    const clientA = createZammadClient({ baseUrl: BASE_URL, token: 'triage-tok-a', fetch: fnA, sleep: async () => {} })
    const clientB = createZammadClient({ baseUrl: BASE_URL, token: 'accounts-tok-b', fetch: fnB, sleep: async () => {} })
    await clientA.getTicket(1)
    await clientB.getTicket(2)
    assert.equal(callsA[0]!.headers.authorization, AUTH_HEADER_SHAPE('triage-tok-a'))
    assert.equal(callsB[0]!.headers.authorization, AUTH_HEADER_SHAPE('accounts-tok-b'))
    assert.ok(!JSON.stringify(callsA[0]!.headers).includes('env-tok-should-never-be-used'))
    assert.ok(!JSON.stringify(callsB[0]!.headers).includes('env-tok-should-never-be-used'))
    assert.ok(!JSON.stringify(callsA[0]!.headers).includes('accounts-tok-b'))
  } finally {
    delete process.env.ZAMMAD_TOKEN
  }
})

test('TOKENS: client reads NO env var — deleting it changes nothing; empty token refused at construction', () => {
  assert.throws(
    () => createZammadClient({ baseUrl: BASE_URL, token: '' , fetch: (async () => {
      throw new Error('x')
    }) as unknown as typeof globalThis.fetch }),
    TypeError,
  )
  assert.throws(
    () => createZammadClient({ baseUrl: BASE_URL, token: undefined as unknown as string, fetch: (async () => {
      throw new Error('x')
    }) as unknown as typeof globalThis.fetch }),
    TypeError,
  )
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

test('transport failure -> ZammadTransportError with sanitized causeName, no raw cause', async () => {
  const throwing = (async () => {
    const raw = new Error('connect ECONNREFUSED zammad.example.test:443')
    ;(raw as Error & { code?: string }).code = 'ECONNREFUSED'
    throw raw
  }) as unknown as typeof globalThis.fetch
  const client = createZammadClient({ baseUrl: BASE_URL, token: TOKEN, fetch: throwing, sleep: async () => {} })
  await assert.rejects(
    () => client.getTicket(1),
    (err: unknown) => {
      if (!(err instanceof ZammadTransportError)) return false
      assert.equal(err.method, 'GET')
      assert.equal(err.path, '/api/v1/tickets/1')
      assert.equal(err.cause, undefined)
      assert.equal(err.causeName, 'Error')
      assert.equal(err.causeCode, 'ECONNREFUSED')
      assert.ok(!err.message.includes('ECONNREFUSED zammad'))
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
