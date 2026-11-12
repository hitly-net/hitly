import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { handleIngestPost, INGEST_LIMITED_LOG } from './ingest-route'
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
})
