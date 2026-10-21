import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import type { EvidenceEvent } from '@hitly/core'
import { setDestinationCheckTestHooks } from '@hitly/core/destination-check'
import { HttpEvidenceSink, S3EvidenceSink, pingEvidenceSink } from './evidence-sink'
import {
  CANARY,
  DEVELOPMENT,
  PRODUCTION,
  PRODUCTION_ALLOWED,
  captureConsole,
  startStub,
  withEnv,
  type StubServer,
} from './destination-test-helpers'

/**
 * Evidence sinks go through the destination check at send time.
 * Run with: yarn workspace @hitly/app test
 */

const event: EvidenceEvent = {
  spec: 'hitly.evidence.v1',
  event_id: 'evt_dest_1',
  approval_id: 'apr_1',
  event_type: 'requested',
  seq: 1,
  occurred_at: '2026-01-01T00:00:00.000Z',
  origin: { plugin: 'mastra', projectId: 'prj_1', runId: 'run_1' },
  action: { name: 'test', args: {}, proposed_sha256: 'abc' },
  retention: { min_days: 180 },
  integrity: { alg: 'sha256', content_sha256: 'hash_1' },
}

let ok: StubServer
let failing: StubServer
let redirecting: StubServer
let target: StubServer

before(async () => {
  ok = await startStub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  failing = await startStub((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(CANARY)
  })
  target = await startStub((_req, res) => res.end('ok'))
  redirecting = await startStub((_req, res) => {
    res.writeHead(302, { location: `${target.url}/elsewhere` })
    res.end(CANARY)
  })
})

after(() => {
  for (const s of [ok, failing, redirecting, target]) s.close()
})

afterEach(() => setDestinationCheckTestHooks())

describe('HTTP evidence sink', () => {
  it('refuses a 127.0.0.1 sink in production without the flag and does not connect', async () => {
    const before = ok.hits.length
    await withEnv(PRODUCTION, async () => {
      await assert.rejects(new HttpEvidenceSink({ url: `${ok.url}/in` }).append(event), /HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS/)
    })
    assert.equal(ok.hits.length, before)
  })

  it('still refuses with the flag set to "1" or "TRUE"', async () => {
    for (const value of ['1', 'TRUE']) {
      await withEnv({ NODE_ENV: 'production', HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS: value }, async () => {
        await assert.rejects(new HttpEvidenceSink({ url: `${ok.url}/in` }).append(event), /not allowed/)
      })
    }
  })

  it('allows a 127.0.0.1 sink in production with the flag set to "true"', async () => {
    await withEnv(PRODUCTION_ALLOWED, async () => {
      const receipt = await new HttpEvidenceSink({ url: `${ok.url}/in` }).append(event)
      assert.equal(receipt.event_id, event.event_id)
    })
  })

  it('allows a 127.0.0.1 sink outside production', async () => {
    await withEnv(DEVELOPMENT, async () => {
      const receipt = await new HttpEvidenceSink({ url: `${ok.url}/in` }).append(event)
      assert.equal(receipt.event_id, event.event_id)
    })
  })

  it('refuses redirects and does not contact the redirect target', async () => {
    const before = target.hits.length
    await withEnv(DEVELOPMENT, async () => {
      await assert.rejects(new HttpEvidenceSink({ url: `${redirecting.url}/in` }).append(event), /redirects are not followed \(status 302\)/)
    })
    assert.equal(target.hits.length, before)
  })

  it('error omits the response body, path and query, including in console output', async () => {
    const { error, output } = await withEnv(DEVELOPMENT, () =>
      captureConsole(() => new HttpEvidenceSink({ url: `${failing.url}/private-path?token=q1` }).append(event)),
    )
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Evidence sink HTTP POST failed (500) for host "127.0.0.1".')
    for (const text of [error.message, output]) {
      assert.ok(!text.includes(CANARY))
      assert.ok(!text.includes('private-path'))
      assert.ok(!text.includes('token=q1'))
    }
  })
})

describe('S3 evidence sink', () => {
  const s3 = (endpoint: string, forcePathStyle = true) =>
    new S3EvidenceSink({
      endpoint,
      region: 'local',
      bucket: 'evidence',
      accessKeyId: 'AKTEST',
      secretAccessKey: 'secret-test',
      forcePathStyle,
    })

  it('refuses a 127.0.0.1 endpoint in production without the flag', async () => {
    const before = ok.hits.length
    await withEnv(PRODUCTION, async () => {
      await assert.rejects(s3(ok.url).append(event), /HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS/)
    })
    assert.equal(ok.hits.length, before)
  })

  it('allows a 127.0.0.1 endpoint with the flag set to "true"', async () => {
    await withEnv(PRODUCTION_ALLOWED, async () => {
      const receipt = await s3(ok.url).append(event)
      assert.ok(receipt.store_uri.endsWith('/evidence/evt_dest_1.json'))
    })
  })

  it('checks the bucket host derived from the endpoint', async () => {
    const asked: string[] = []
    setDestinationCheckTestHooks({
      resolve: async (host) => {
        asked.push(host)
        return [{ address: '10.1.2.3' }]
      },
    })
    await withEnv(PRODUCTION, async () => {
      await assert.rejects(s3('https://storage.example.com', false).append(event), /not allowed/)
    })
    assert.deepEqual(asked, ['evidence.storage.example.com'])
  })

  it('error omits the response body', async () => {
    const { error, output } = await withEnv(DEVELOPMENT, () => captureConsole(() => s3(failing.url).append(event)))
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Evidence sink S3 PutObject failed (500) for host "127.0.0.1".')
    assert.ok(!output.includes(CANARY))
  })
})

describe('evidence sink test ping (shown in project settings)', () => {
  it('returns status and host only, never the response body', async () => {
    const result = await withEnv(DEVELOPMENT, () => pingEvidenceSink(`${failing.url}/in?key=k1`))
    assert.deepEqual(result, { ok: false, status: 500, message: 'Evidence sink returned 500 for host "127.0.0.1".' })
    assert.ok(!JSON.stringify(result).includes(CANARY))
  })

  it('names the flag when production refuses the target', async () => {
    const result = await withEnv(PRODUCTION, () => pingEvidenceSink(`${ok.url}/in`))
    assert.equal(result.ok, false)
    assert.ok(result.message.includes('HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS'))
  })

  it('reports a redirect without following it', async () => {
    const before = target.hits.length
    const result = await withEnv(DEVELOPMENT, () => pingEvidenceSink(`${redirecting.url}/in`))
    assert.equal(result.ok, false)
    assert.ok(result.message.includes('status 302'))
    assert.ok(!result.message.includes(CANARY))
    assert.equal(target.hits.length, before)
  })

  it('succeeds against a reachable 127.0.0.1 sink outside production', async () => {
    const result = await withEnv(DEVELOPMENT, () => pingEvidenceSink(`${ok.url}/in`))
    assert.deepEqual(result, { ok: true, status: 200, message: 'Evidence sink is reachable' })
  })
})
