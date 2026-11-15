import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { handleIngestPost, INGEST_LIMITED_LOG, INGEST_FAILED_AUTH_LOG } from './ingest-route'
import { hashApiKey } from './keys'

const KEY = 'hitly_' + 'a'.repeat(32)

function post(body?: unknown, authorization: string | null = `Bearer ${KEY}`): Request {
  return new Request('http://localhost:3001/api/v1/approvals', {
    method: 'POST',
    headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('POST /api/v1/approvals ingest limiter', () => {
  it('missing API key answers 401 before the limiter is consulted', async () => {
    let consulted = false
    const response = await handleIngestPost(post(undefined, null), {
      acquire: () => {
        consulted = true
        return { allowed: true, retryAfterMs: 0, count: 1 }
      },
      log: () => {},
    })
    assert.equal(response.status, 401)
    assert.equal(consulted, false)
  })

  it('over-budget keys answer 429 with Retry-After and one fixed log line', async () => {
    const lines: string[] = []
    const subjects: string[] = []
    const response = await handleIngestPost(post({ plugin: 'x' }), {
      authenticate: async () => ({ project: { id: 'prj_x' } }),
      acquire: (subject) => {
        subjects.push(subject)
        return { allowed: false, retryAfterMs: 45_000, count: 121 }
      },
      log: (line) => lines.push(line),
    })
    assert.equal(response.status, 429)
    assert.deepEqual(await response.json(), { error: 'too_many_requests' })
    assert.equal(response.headers.get('retry-after'), '45')
    assert.deepEqual(lines, [INGEST_LIMITED_LOG])
    assert.deepEqual(subjects, [hashApiKey(KEY)], 'the bucket subject is the API key hash, never the key')
    assert.ok(!JSON.stringify(lines).includes(KEY), 'the log line never names the key')
  })

  it('an allowed request reaches the handler body checks (gate order)', async () => {
    const subjects: string[] = []
    const response = await handleIngestPost(post(undefined), {
      authenticate: async () => ({ project: { id: 'prj_x' } }),
      acquire: (subject) => {
        subjects.push(subject)
        return { allowed: true, retryAfterMs: 0, count: 1 }
      },
      log: () => {},
    })
    assert.equal(subjects.length, 1)
    assert.equal(response.status, 400, 'empty body is the next check after the budget')
    const body = (await response.json()) as { error: string }
    assert.match(body.error, /JSON body required/)
  })

  it('a malformed key never reaches the per-key limiter; it counts per address (M5)', async () => {
    const keySubjects: string[] = []
    const failedSubjects: string[] = []
    const lines: string[] = []
    let authenticated = false
    await handleIngestPost(post({ plugin: 'x' }, `Bearer not-a-hitly-key`), {
      authenticate: async () => {
        authenticated = true
        return { project: { id: 'prj_x' } }
      },
      acquire: (subject) => {
        keySubjects.push(subject)
        return { allowed: true, retryAfterMs: 0, count: 1 }
      },
      failedAcquire: (subject) => {
        failedSubjects.push(subject)
        return { allowed: true, retryAfterMs: 0, count: 1 }
      },
      log: (line) => lines.push(line),
    })
    assert.equal(keySubjects.length, 0, 'a junk key must never mint a per-key bucket')
    assert.equal(authenticated, false, 'a junk key is not even looked up')
    assert.equal(failedSubjects.length, 1)
    assert.match(failedSubjects[0]!, /^addr:/, 'junk attempts count per client address')
  })

  it('a well-formed but unknown key counts per address only, never per key (M5)', async () => {
    const keySubjects: string[] = []
    const failedSubjects: string[] = []
    await handleIngestPost(post({ plugin: 'x' }), {
      authenticate: async () => null,
      acquire: (subject) => {
        keySubjects.push(subject)
        return { allowed: true, retryAfterMs: 0, count: 1 }
      },
      failedAcquire: (subject) => {
        failedSubjects.push(subject)
        return { allowed: true, retryAfterMs: 0, count: 1 }
      },
      log: () => {},
    })
    assert.equal(keySubjects.length, 0, 'an unverified key must never mint a per-key bucket')
    assert.deepEqual(failedSubjects, [failedSubjects[0]])
    assert.match(failedSubjects[0]!, /^addr:/)
  })

  it('a well-formed but unknown key that trips the budget gets 429 (F4c)', async () => {
    const lines: string[] = []
    const keySubjects: string[] = []
    const response = await handleIngestPost(post({ plugin: 'x' }), {
      authenticate: async () => null,
      acquire: (subject) => {
        keySubjects.push(subject)
        return { allowed: true, retryAfterMs: 0, count: 1 }
      },
      failedAcquire: () => ({ allowed: false, retryAfterMs: 30_000, count: 61 }),
      log: (line) => lines.push(line),
    })
    assert.equal(response.status, 429, 'the unknown-key branch must consult the failed-auth budget')
    assert.equal(response.headers.get('retry-after'), '30')
    assert.deepEqual(lines, [INGEST_FAILED_AUTH_LOG])
    assert.equal(keySubjects.length, 0)
  })

  it('the failed-auth budget answers 429 with Retry-After (M5)', async () => {
    const lines: string[] = []
    const response = await handleIngestPost(post({ plugin: 'x' }, `Bearer junk_key`), {
      failedAcquire: () => ({ allowed: false, retryAfterMs: 30_000, count: 61 }),
      log: (line) => lines.push(line),
    })
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('retry-after'), '30')
    assert.deepEqual(lines, [INGEST_FAILED_AUTH_LOG])
  })

  it('a valid key is counted per hash only after it authenticates (M5)', async () => {
    const order: string[] = []
    const response = await handleIngestPost(post(undefined), {
      authenticate: async () => {
        order.push('authenticate')
        return { project: { id: 'prj_x' } }
      },
      acquire: () => {
        order.push('count')
        return { allowed: true, retryAfterMs: 0, count: 1 }
      },
      log: () => {},
    })
    assert.deepEqual(order, ['authenticate', 'count'])
    assert.equal(response.status, 400)
  })
})
