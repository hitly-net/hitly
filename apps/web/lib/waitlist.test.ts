import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitlistWebhookUrl } from '@/lib/waitlist'
import { POST } from '@/app/api/waitlist/route'

/**
 * The waitlist webhook is opt-in: WAITLIST_WEBHOOK_URL with no built-in
 * default. Unset / empty / whitespace-only means the signup is accepted and
 * NO outbound fetch happens at all. A set value means exactly one POST to
 * that URL. No default destination URL may remain in the source.
 */

const WEBHOOK_ENV = 'WAITLIST_WEBHOOK_URL'
const OPT_IN_URL = 'https://hooks.example.test/waitlist'

type FetchCall = { input: RequestInfo | URL; init: RequestInit | undefined }

async function withFetchSpy(run: (calls: FetchCall[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return new Response('{}', { status: 200 })
  }) as typeof globalThis.fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

async function withEnv(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const had = Object.hasOwn(process.env, WEBHOOK_ENV)
  const previous = process.env[WEBHOOK_ENV]
  if (value === undefined) delete process.env[WEBHOOK_ENV]
  else process.env[WEBHOOK_ENV] = value
  try {
    await run()
  } finally {
    if (had) process.env[WEBHOOK_ENV] = previous
    else delete process.env[WEBHOOK_ENV]
  }
}

// Opt-in must hold in production too: a production-only default destination
// (the pre-fix shape) has to fail these tests, not just the unset NODE_ENV.
async function withNodeEnv(value: string, run: () => Promise<void>): Promise<void> {
  const env = process.env as Record<string, string | undefined>
  const had = Object.hasOwn(env, 'NODE_ENV')
  const previous = env.NODE_ENV
  env.NODE_ENV = value
  try {
    await run()
  } finally {
    if (had) env.NODE_ENV = previous
    else delete env.NODE_ENV
  }
}

function signupRequest(): Request {
  return new Request('http://localhost:3000/api/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada', email: 'ada@example.test', integrations: ['n8n'], other: '' }),
  })
}

test('waitlistWebhookUrl has no default and treats blank values as unset', async () => {
  for (const value of [undefined, '', '   ', '\t\n ']) {
    await withEnv(value, async () => {
      assert.equal(waitlistWebhookUrl(), null, `no destination when env is ${JSON.stringify(value)}`)
    })
    await withNodeEnv('production', () =>
      withEnv(value, async () => {
        assert.equal(
          waitlistWebhookUrl(),
          null,
          `no destination in production when env is ${JSON.stringify(value)}`,
        )
      }),
    )
  }
  await withEnv(`  ${OPT_IN_URL}  `, async () => {
    assert.equal(waitlistWebhookUrl(), OPT_IN_URL, 'a set value is trimmed, not defaulted')
  })
})

for (const [label, value] of [
  ['unset', undefined],
  ['empty string', ''],
  ['spaces only', '   '],
  ['whitespace only', '\t \n '],
] as const) {
  test(`POST /api/waitlist with ${label}: signup succeeds with zero outbound fetches`, async () => {
    await withEnv(value, () =>
      withFetchSpy(async (calls) => {
        const response = await POST(signupRequest())
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true })
        assert.equal(calls.length, 0, 'no outbound fetch when the webhook is not configured')
      }),
    )
  })

  test(`POST /api/waitlist with ${label} and NODE_ENV=production: signup succeeds with zero outbound fetches`, async () => {
    await withNodeEnv('production', () =>
      withEnv(value, () =>
        withFetchSpy(async (calls) => {
          const response = await POST(signupRequest())
          assert.equal(response.status, 200)
          assert.deepEqual(await response.json(), { ok: true })
          assert.equal(calls.length, 0, 'no outbound fetch in production when the webhook is not configured')
        }),
      ),
    )
  })
}

test('POST /api/waitlist with the env set: exactly one POST to that URL', async () => {
  await withEnv(OPT_IN_URL, () =>
    withFetchSpy(async (calls) => {
      const response = await POST(signupRequest())
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true })
      assert.equal(calls.length, 1, 'exactly one outbound request')
      assert.equal(calls[0].input, OPT_IN_URL)
      assert.equal(calls[0].init?.method, 'POST')
      const headers = calls[0].init?.headers as Record<string, string>
      assert.equal(headers['Content-Type'], 'application/json')
      assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
        name: 'Ada',
        email: 'ada@example.test',
        integrations: ['n8n'],
        other: '',
      })
    }),
  )
})

test('POST /api/waitlist posts the trimmed URL when the env has surrounding whitespace', async () => {
  await withEnv(`  ${OPT_IN_URL}\n`, () =>
    withFetchSpy(async (calls) => {
      const response = await POST(signupRequest())
      assert.equal(response.status, 200)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].input, OPT_IN_URL)
    }),
  )
})

test('POST /api/waitlist returns 502 only when a configured webhook POST fails', async () => {
  const original = globalThis.fetch
  await withEnv(OPT_IN_URL, async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof globalThis.fetch
    try {
      const response = await POST(signupRequest())
      assert.equal(response.status, 502)
    } finally {
      globalThis.fetch = original
    }
  })
})

test('invalid payloads are still 400 without any fetch, webhook set or not', async () => {
  const bad = new Request('http://localhost:3000/api/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '', email: 'not-an-email', integrations: [], other: '' }),
  })
  for (const value of [undefined, OPT_IN_URL]) {
    await withEnv(value, () =>
      withFetchSpy(async (calls) => {
        const response = await POST(bad)
        assert.equal(response.status, 400)
        assert.equal(calls.length, 0)
      }),
    )
  }
})

test('no hard-coded destination URL remains in the waitlist source', () => {
  for (const rel of ['lib/waitlist.ts', 'app/api/waitlist/route.ts']) {
    const source = readFileSync(join(import.meta.dirname, '..', rel), 'utf8')
    assert.ok(!/https?:\/\//.test(source), `${rel} must contain no URL literal destination`)
  }
})
