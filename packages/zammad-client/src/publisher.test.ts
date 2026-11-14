import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZammadHashMismatchError } from './errors.ts'
import { createZammadPublisher, sha256Hex } from './publisher.ts'

const BASE_URL = 'https://zammad.example.test'
const TOKEN = 'unit-test-token-not-a-secret'

interface RecordedCall {
  url: string
  method: string
  body: unknown
}

function makePublisher(responses: Array<{ status: number; body?: unknown }>) {
  const calls: RecordedCall[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? 'GET'),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: `status ${next.status}`,
      json: async () => next.body,
    }
  }) as unknown as typeof globalThis.fetch
  const publisher = createZammadPublisher({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetch: fn,
    sleep: async () => {},
  })
  return { publisher, calls }
}

const ok = (body: unknown) => ({ status: 200, body })

const LIVE_BODY = '<p>Current published text.</p>'

/** Response shaped like the docs Show example (assets graph). */
function answerWithInlineContent(body: string, opts?: { translationId?: number; contentId?: number }) {
  const translationId = opts?.translationId ?? 7
  const contentId = opts?.contentId ?? 12
  return {
    id: 9,
    assets: {
      KnowledgeBaseAnswer: {
        '9': { id: 9, category_id: 5, translation_ids: [translationId] },
      },
      KnowledgeBaseAnswerTranslation: {
        [String(translationId)]: {
          id: translationId,
          answer_id: 9,
          kb_locale_id: 1,
          title: 'Answer 9',
          content_id: contentId,
        },
      },
      KnowledgeBaseAnswerTranslationContent: {
        [String(contentId)]: { id: contentId, body },
      },
    },
  }
}

/** Response WITHOUT the content map — forces the include_contents follow-up GET. */
function answerWithoutContent(translationId = 7, contentId = 12) {
  return {
    id: 9,
    assets: {
      KnowledgeBaseAnswer: {
        '9': { id: 9, category_id: 5, translation_ids: [translationId] },
      },
      KnowledgeBaseAnswerTranslation: {
        [String(translationId)]: {
          id: translationId,
          answer_id: 9,
          kb_locale_id: 1,
          title: 'Answer 9',
          content_id: contentId,
        },
      },
    },
  }
}

test('sha256Hex matches known vectors and node:crypto directly', async () => {
  const { createHash } = await import('node:crypto')
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Hex('ünïcøde\n'), createHash('sha256').update('ünïcøde\n', 'utf8').digest('hex'))
})

test('publishAnswer: POST to the publish endpoint', async () => {
  const { publisher, calls } = makePublisher([ok({ id: 9 })])
  await publisher.publishAnswer(3, 9)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/knowledge_bases/3/answers/9/publish`)
  assert.equal(calls[0]!.method, 'POST')
})

test('updateLiveAnswer: hash match -> PATCH with translations_attributes body', async () => {
  const newBody = '<p>Approved replacement.</p>'
  const { publisher, calls } = makePublisher([
    ok(answerWithInlineContent(LIVE_BODY, { translationId: 7 })),
    ok({ id: 9 }),
  ])
  await publisher.updateLiveAnswer(3, 9, newBody, sha256Hex(LIVE_BODY))
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.method, 'GET')
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/knowledge_bases/3/answers/9`)
  assert.equal(calls[1]!.method, 'PATCH')
  assert.equal(calls[1]!.url, `${BASE_URL}/api/v1/knowledge_bases/3/answers/9`)
  assert.deepEqual(calls[1]!.body, {
    translations_attributes: [{ id: 7, content_attributes: { body: newBody } }],
  })
})

test('updateLiveAnswer: expectedCurrentHash is case-insensitive', async () => {
  const { publisher, calls } = makePublisher([
    ok(answerWithInlineContent(LIVE_BODY)),
    ok({ id: 9 }),
  ])
  await publisher.updateLiveAnswer(3, 9, 'x', sha256Hex(LIVE_BODY).toUpperCase())
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.method, 'PATCH')
})

test('updateLiveAnswer: hash MISMATCH -> typed refusal, zero writes', async () => {
  const { publisher, calls } = makePublisher([ok(answerWithInlineContent(LIVE_BODY))])
  const staleHash = sha256Hex('<p>Text the approver thought was live.</p>')
  await assert.rejects(
    () => publisher.updateLiveAnswer(3, 9, '<p>evil overwrite</p>', staleHash),
    (err: unknown) => {
      if (!(err instanceof ZammadHashMismatchError)) return false
      assert.equal(err.kbId, 3)
      assert.equal(err.answerId, 9)
      assert.equal(err.expectedCurrentHash, staleHash)
      assert.equal(err.actualHash, sha256Hex(LIVE_BODY))
      assert.ok(!err.message.includes(TOKEN))
      return true
    },
  )
  // The compare-and-swap must have read only — no PATCH/PUT/POST anywhere.
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.method, 'GET')
})

test('updateLiveAnswer: fetches body via include_contents when missing', async () => {
  const newBody = '<p>new</p>'
  const { publisher, calls } = makePublisher([
    ok(answerWithoutContent(7, 12)),
    ok(answerWithInlineContent(LIVE_BODY, { translationId: 7, contentId: 12 })),
    ok({ id: 9 }),
  ])
  await publisher.updateLiveAnswer(3, 9, newBody, sha256Hex(LIVE_BODY))
  assert.equal(calls.length, 3)
  assert.equal(calls[1]!.url, `${BASE_URL}/api/v1/knowledge_bases/3/answers/9?include_contents=7`)
  assert.equal(calls[2]!.method, 'PATCH')
})

test('updateLiveAnswer: unreadable live body -> shape error, no write', async () => {
  const { publisher, calls } = makePublisher([ok(answerWithoutContent()), ok({ id: 9, assets: {} })])
  await assert.rejects(
    () => publisher.updateLiveAnswer(3, 9, 'x', sha256Hex('whatever')),
    (err: unknown) => err instanceof Error && err.name === 'ZammadResponseShapeError',
  )
  assert.ok(calls.every((c) => c.method === 'GET'))
})

test('publisher client keeps all main-entry read/write methods too', async () => {
  const { publisher } = makePublisher([ok({ id: 1 })])
  for (const method of [
    'getTicket',
    'listArticles',
    'addPublicEmailReply',
    'addInternalNote',
    'updateTicket',
    'searchTickets',
    'kbSearch',
    'kbGetAnswer',
    'kbCreateDraftAnswer',
    'publishAnswer',
    'updateLiveAnswer',
  ] as const) {
    assert.equal(typeof publisher[method], 'function', `${method} must exist on publisher`)
  }
})
