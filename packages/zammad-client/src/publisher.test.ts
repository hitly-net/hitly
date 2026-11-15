import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ZammadConflictError,
  ZammadHashMismatchError,
  ZammadInvalidHashError,
  createZammadPublisher,
  normalizeContentHash,
  sha256Hex,
} from './publisher.ts'

const BASE_URL = 'https://zammad.example.test'
const TOKEN = 'pub-tok-2c8d'

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
      headers: new Headers(),
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

/**
 * The CURRENT DRAFT translation is id 12 (content 22, draftBody) via
 * translation_ids[0]. An older PUBLISHED translation id 11 (content 21,
 * liveBody) is listed FIRST in the map and shares answer_id 9 — so any code
 * that hashes/patches the wrong (live/published) row diverges visibly.
 * Draft and live content are DIFFERENT by contract.
 */
function answerWithDraftAndLive(draftBody: string, liveBody: string, title = 'Answer 9') {
  return {
    id: 9,
    assets: {
      KnowledgeBaseAnswer: {
        '9': { id: 9, category_id: 5, translation_ids: [12] },
      },
      KnowledgeBaseAnswerTranslation: {
        '11': { id: 11, answer_id: 9, kb_locale_id: 1, title: `${title} (published)`, content_id: 21 },
        '12': { id: 12, answer_id: 9, kb_locale_id: 1, title, content_id: 22 },
      },
      KnowledgeBaseAnswerTranslationContent: {
        '21': { id: 21, body: liveBody },
        '22': { id: 22, body: draftBody },
      },
    },
  }
}

/** Response WITHOUT the content map — forces the include_contents follow-up GET. */
function answerWithoutContent() {
  return {
    id: 9,
    assets: {
      KnowledgeBaseAnswer: {
        '9': { id: 9, category_id: 5, translation_ids: [12] },
      },
      KnowledgeBaseAnswerTranslation: {
        '12': { id: 12, answer_id: 9, kb_locale_id: 1, title: 'Answer 9', content_id: 22 },
      },
    },
  }
}

const DRAFT_BODY = '<p>Draft text with ünïcøde.</p>'
const LIVE_BODY = '<p>Older published text.</p>'

// ---------------------------------------------------------------------------
// sha256Hex + hash validation (M3, kills "different encoding")
// ---------------------------------------------------------------------------

test('sha256Hex matches known vectors and node:crypto directly (utf8 encoding pinned)', async () => {
  const { createHash } = await import('node:crypto')
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Hex('ünïcøde\n'), createHash('sha256').update('ünïcøde\n', 'utf8').digest('hex'))
  assert.notEqual(sha256Hex('ünïcøde'), createHash('sha256').update('ünïcøde', 'latin1').digest('hex'))
})

test('normalizeContentHash accepts 64-hex (case-insensitive, trimmed)', () => {
  const h = 'a'.repeat(64)
  assert.equal(normalizeContentHash(h, 'x'), h)
  assert.equal(normalizeContentHash(h.toUpperCase(), 'x'), h)
  assert.equal(normalizeContentHash(` ${h} `, 'x'), h)
})

test('normalizeContentHash refuses empty, truncated, over-long, non-hex, non-string', () => {
  for (const bad of ['', '   ', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'z'.repeat(64), 'n'.repeat(64), 42, null, undefined, {}]) {
    assert.throws(
      () => normalizeContentHash(bad, 'expectedCurrentHash'),
      (err: unknown) => err instanceof ZammadInvalidHashError,
      `must refuse ${JSON.stringify(bad)}`,
    )
  }
})

// ---------------------------------------------------------------------------
// updateLiveAnswer (M3 before any network call; CAS refusal)
// ---------------------------------------------------------------------------

test('M3: updateLiveAnswer refuses malformed hashes BEFORE any network call', async () => {
  for (const bad of ['', 'a'.repeat(63), 'nothex'.padEnd(64, 'g'), 'A'.repeat(63) + 'g']) {
    const { publisher, calls } = makePublisher([ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY))])
    await assert.rejects(
      () => publisher.updateLiveAnswer(3, 9, 'new', bad),
      (err: unknown) => err instanceof ZammadInvalidHashError,
    )
    assert.equal(calls.length, 0, `malformed hash ${bad.slice(0, 6)}... must not trigger any fetch`)
  }
})

test('updateLiveAnswer: hash match -> GET then PATCH with CURRENT draft translation id', async () => {
  const newBody = '<p>Approved replacement.</p>'
  const { publisher, calls } = makePublisher([
    ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY)),
    ok({ id: 9 }),
  ])
  await publisher.updateLiveAnswer(3, 9, newBody, sha256Hex(DRAFT_BODY))
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.method, 'GET')
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/knowledge_bases/3/answers/9`)
  assert.equal(calls[1]!.method, 'PATCH')
  assert.deepEqual(calls[1]!.body, {
    // MUST be the draft translation (12), never the published row (11).
    translations_attributes: [{ id: 12, content_attributes: { body: newBody } }],
  })
})

test('updateLiveAnswer: expectedCurrentHash is case-insensitive', async () => {
  const { publisher, calls } = makePublisher([
    ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY)),
    ok({ id: 9 }),
  ])
  await publisher.updateLiveAnswer(3, 9, 'x', sha256Hex(DRAFT_BODY).toUpperCase())
  assert.equal(calls[1]!.method, 'PATCH')
})

test('updateLiveAnswer: hash MISMATCH -> typed refusal, zero writes', async () => {
  const { publisher, calls } = makePublisher([ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY))])
  const staleHash = sha256Hex('<p>Text the approver thought was live.</p>')
  await assert.rejects(
    () => publisher.updateLiveAnswer(3, 9, '<p>evil overwrite</p>', staleHash),
    (err: unknown) => {
      if (!(err instanceof ZammadHashMismatchError)) return false
      assert.equal(err.kbId, 3)
      assert.equal(err.answerId, 9)
      assert.equal(err.expectedCurrentHash, staleHash)
      assert.equal(err.actualHash, sha256Hex(DRAFT_BODY))
      return true
    },
  )
  assert.ok(calls.every((c) => c.method === 'GET'), 'CAS refusal must be read-only')
})

test('updateLiveAnswer: refuses with the PUBLISHED hash (live != draft by contract)', async () => {
  const { publisher, calls } = makePublisher([ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY))])
  await assert.rejects(
    () => publisher.updateLiveAnswer(3, 9, 'x', sha256Hex(LIVE_BODY)),
    ZammadHashMismatchError,
  )
  assert.ok(calls.every((c) => c.method === 'GET'))
})

test('updateLiveAnswer: fetches body via include_contents when missing', async () => {
  const { publisher, calls } = makePublisher([
    ok(answerWithoutContent()),
    ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY)),
    ok({ id: 9 }),
  ])
  await publisher.updateLiveAnswer(3, 9, '<p>new</p>', sha256Hex(DRAFT_BODY))
  assert.equal(calls.length, 3)
  assert.equal(calls[1]!.url, `${BASE_URL}/api/v1/knowledge_bases/3/answers/9?include_contents=12`)
  assert.equal(calls[2]!.method, 'PATCH')
})

test('updateLiveAnswer: ambiguous translation rows (no translation_ids, two owned) -> shape error, no write', async () => {
  const ambiguous = {
    id: 9,
    assets: {
      KnowledgeBaseAnswerTranslation: {
        '11': { id: 11, answer_id: 9, content_id: 21 },
        '12': { id: 12, answer_id: 9, content_id: 22 },
      },
      KnowledgeBaseAnswerTranslationContent: {
        '21': { id: 21, body: LIVE_BODY },
        '22': { id: 22, body: DRAFT_BODY },
      },
    },
  }
  const { publisher, calls } = makePublisher([ok(ambiguous)])
  await assert.rejects(
    () => publisher.updateLiveAnswer(3, 9, 'x', sha256Hex(DRAFT_BODY)),
    (err: unknown) => err instanceof Error && err.name === 'ZammadResponseShapeError',
  )
  assert.ok(calls.every((c) => c.method === 'GET'))
})

// ---------------------------------------------------------------------------
// M5: publishAnswer requires the approved content hash
// ---------------------------------------------------------------------------

test('M5: publishAnswer requires a hash — argument is mandatory (arity pin)', () => {
  const { publisher } = makePublisher([])
  assert.equal(publisher.publishAnswer.length, 3, 'publishAnswer(kbId, answerId, approvedContentHash)')
})

test('M5: matching hash publishes exactly once; read + compare happen BEFORE the publish call', async () => {
  const { publisher, calls } = makePublisher([
    ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY)),
    ok({ id: 9, published_at: 'now' }),
  ])
  const got = await publisher.publishAnswer(3, 9, sha256Hex(DRAFT_BODY))
  assert.deepEqual(got, { id: 9, published_at: 'now' })
  assert.equal(calls.length, 2)
  // Order pin (kills "publish before compare"): the only POST is the publish,
  // and it comes AFTER the draft read.
  assert.equal(calls[0]!.method, 'GET')
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/knowledge_bases/3/answers/9`)
  assert.equal(calls[1]!.method, 'POST')
  assert.equal(calls[1]!.url, `${BASE_URL}/api/v1/knowledge_bases/3/answers/9/publish`)
})

test('M5: mismatching hash -> ZammadConflictError with status 409 and ZERO publish calls', async () => {
  const { publisher, calls } = makePublisher([ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY))])
  await assert.rejects(
    () => publisher.publishAnswer(3, 9, sha256Hex('some other approved text')),
    (err: unknown) => {
      if (!(err instanceof ZammadConflictError)) return false
      assert.equal(err.status, 409, 'conflict must carry status 409')
      assert.equal(err.name, 'ZammadConflictError')
      assert.equal(err.kbId, 3)
      assert.equal(err.answerId, 9)
      assert.equal(err.approvedContentHash, sha256Hex('some other approved text'))
      assert.equal(err.actualHash, sha256Hex(DRAFT_BODY))
      return true
    },
  )
  assert.equal(calls.length, 1, 'only the draft read may happen')
  assert.equal(calls[0]!.method, 'GET')
  assert.ok(calls.every((c) => !c.url.endsWith('/publish')), 'NO publish call on mismatch')
})

test('M5: comparing LIVE (published) text instead of DRAFT is detectable — hash of live text must NOT publish', async () => {
  // draft and live content DIFFER by fixture contract.
  assert.notEqual(DRAFT_BODY, LIVE_BODY)
  const { publisher, calls } = makePublisher([ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY))])
  await assert.rejects(
    () => publisher.publishAnswer(3, 9, sha256Hex(LIVE_BODY)),
    (err: unknown) => err instanceof ZammadConflictError && err.status === 409,
  )
  assert.ok(calls.every((c) => c.method === 'GET'), 'no publish when only the OLD published text matches')
})

test('M5: hashing a different FIELD (title) is detectable — hash of the draft title must NOT publish', async () => {
  const { publisher, calls } = makePublisher([ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY, 'Very important answer'))])
  await assert.rejects(
    () => publisher.publishAnswer(3, 9, sha256Hex('Very important answer')),
    (err: unknown) => err instanceof ZammadConflictError && err.status === 409,
  )
  assert.ok(calls.every((c) => c.method === 'GET'))
})

test('M5: empty / truncated / non-hex approved hash refused BEFORE any network call', async () => {
  for (const bad of ['', '  ', 'a'.repeat(63), 'a'.repeat(64) + 'f', 'x'.repeat(64)]) {
    const { publisher, calls } = makePublisher([ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY))])
    await assert.rejects(
      () => publisher.publishAnswer(3, 9, bad),
      (err: unknown) => err instanceof ZammadInvalidHashError,
      `must refuse ${JSON.stringify(bad)}`,
    )
    assert.equal(calls.length, 0, 'malformed hash must not trigger any fetch')
  }
})

test('M5: approved hash is case-insensitive and still compares against the draft body', async () => {
  const { publisher, calls } = makePublisher([
    ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY)),
    ok({ id: 9 }),
  ])
  await publisher.publishAnswer(3, 9, sha256Hex(DRAFT_BODY).toUpperCase())
  assert.equal(calls[1]!.method, 'POST')
})

test('M5: the publish POST itself keeps 5xx retries (idempotent action)', async () => {
  const { publisher, calls } = makePublisher([
    ok(answerWithDraftAndLive(DRAFT_BODY, LIVE_BODY)),
    { status: 502 },
    ok({ id: 9 }),
  ])
  await publisher.publishAnswer(3, 9, sha256Hex(DRAFT_BODY))
  assert.equal(calls.length, 3)
  assert.equal(calls[1]!.url.endsWith('/publish'), true)
  assert.equal(calls[2]!.url.endsWith('/publish'), true)
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
    'rawRequest',
    'publishAnswer',
    'updateLiveAnswer',
  ] as const) {
    assert.equal(typeof publisher[method], 'function', `${method} must exist on publisher`)
  }
})
