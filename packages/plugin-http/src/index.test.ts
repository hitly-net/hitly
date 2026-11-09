import { describe, it, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import type { DecisionPayload, OriginRef } from '@hitly/core'
import { DestinationCheckError, globalFetchTransport, setDestinationCheckTestHooks } from '@hitly/core/destination-check'
import {
  buildDecidedBody,
  buildSignatureHeaders,
  containsSecretValue,
  deliverHttpCallback,
  deliverHttpLifecycleEvent,
  HEADER_EVENT_ID,
  HEADER_KEY_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  httpPlugin,
  parseLifecycleEvents,
  redactSecrets,
  signBody,
  verifyHttpSignature,
  webhookKeyId,
  CB_AUTH_TOKEN_KEY,
} from './index.ts'

setDestinationCheckTestHooks({
  resolve: async () => [{ address: '203.0.113.10' }],
  transport: globalFetchTransport,
})

const SECRET = 'whsec_test_signing_secret_m0h'
const TOKEN = 'cb_tok_super_secret_do_not_echo'

function baseOrigin(resumeUrl: string, extra: Record<string, unknown> = {}): OriginRef {
  return {
    plugin: 'http',
    projectId: 'prj_1',
    runId: 'run_1',
    resumeHandle: {
      resumeUrl,
      metadata: { pageId: 'p1', title: 'Refund' },
      approvalId: 'apr_1',
      ...extra,
    },
  }
}

describe('@hitly/plugin-http M0h', () => {
  describe('ingest', () => {
    it('requires resumeUrl and runId', () => {
      assert.throws(() => httpPlugin.ingest({ runId: 'r1' }), /resumeUrl/)
      assert.throws(() => httpPlugin.ingest({ resumeUrl: 'https://example.com/cb' }), /runId/)
    })

    it('stores cb_auth_token on resumeHandle, never in metadata', () => {
      const env = httpPlugin.ingest({
        resumeUrl: 'https://hooks.example/resume',
        runId: 'exec_1',
        projectId: 'prj_1',
        cb_auth_token: TOKEN,
        metadata: { pageId: 'p1' },
      })
      assert.equal(env.origin.resumeHandle[CB_AUTH_TOKEN_KEY], TOKEN)
      assert.equal((env.origin.resumeHandle.metadata as any).cb_auth_token, undefined)
      assert.equal((env.metadata as any)?.cb_auth_token, undefined)
    })

    it('parses opt-in lifecycleEvents', () => {
      const env = httpPlugin.ingest({
        resumeUrl: 'https://hooks.example/resume',
        runId: 'exec_1',
        lifecycleEvents: ['presented', 'expired', 'presented', 'nope'],
      })
      assert.deepEqual(env.origin.resumeHandle.lifecycleEvents, ['presented', 'expired'])
      assert.deepEqual(parseLifecycleEvents(['OPENED', 'cancelled']), ['opened', 'cancelled'])
    })
  })

  describe('HMAC signature vectors', () => {
    it('signs timestamp.body and verifies', () => {
      const rawBody = '{"decision":"accept","event_id":"evt_1"}'
      const ts = 1_736_000_000
      const sig = signBody(SECRET, ts, rawBody)
      assert.equal(sig.length, 64)
      assert.match(sig, /^[0-9a-f]+$/)
      const ok = verifyHttpSignature({
        secret: SECRET,
        rawBody,
        timestampHeader: String(ts),
        signatureHeader: sig,
        keyIdHeader: webhookKeyId(SECRET),
        nowSeconds: ts,
      })
      assert.equal(ok.ok, true)
    })

    it('rejects bad signature, skew, and key mismatch', () => {
      const rawBody = '{"x":1}'
      const ts = 1_736_000_000
      const sig = signBody(SECRET, ts, rawBody)
      assert.equal(
        verifyHttpSignature({
          secret: SECRET,
          rawBody,
          timestampHeader: String(ts),
          signatureHeader: '00'.repeat(32),
          nowSeconds: ts,
        }).ok,
        false,
      )
      assert.equal(
        verifyHttpSignature({
          secret: SECRET,
          rawBody,
          timestampHeader: String(ts),
          signatureHeader: sig,
          nowSeconds: ts + 600,
        }).reason,
        'skew',
      )
      assert.equal(
        verifyHttpSignature({
          secret: SECRET,
          rawBody,
          timestampHeader: String(ts),
          signatureHeader: sig,
          keyIdHeader: 'hk_deadbeef',
          nowSeconds: ts,
        }).reason,
        'key_mismatch',
      )
    })

    it('buildSignatureHeaders expose timestamp, event-id, key-id, signature', () => {
      const headers = buildSignatureHeaders({
        secret: SECRET,
        eventId: 'evt_abc',
        rawBody: '{}',
        timestampSeconds: 100,
      })
      assert.equal(headers[HEADER_TIMESTAMP], '100')
      assert.equal(headers[HEADER_EVENT_ID], 'evt_abc')
      assert.equal(headers[HEADER_KEY_ID], webhookKeyId(SECRET))
      assert.equal(headers[HEADER_SIGNATURE], signBody(SECRET, 100, '{}'))
    })
  })

  describe('token never echoed + redaction', () => {
    it('redactSecrets strips cbAuthToken', () => {
      const redacted = redactSecrets({
        resumeUrl: 'https://hooks.example/r',
        cbAuthToken: TOKEN,
        metadata: { pageId: 'p1', nested: { cbAuthToken: TOKEN } },
      })
      assert.equal((redacted as any).cbAuthToken, undefined)
      assert.equal((redacted as any).metadata.nested.cbAuthToken, undefined)
      assert.equal(containsSecretValue(redacted, TOKEN), false)
    })

    it('resumeData and decided body never contain the Bearer token', async () => {
      const fetches: Array<{ headers: Headers; body: string }> = []
      mock.method(globalThis, 'fetch', async (_input: any, init?: any) => {
        fetches.push({ headers: new Headers(init?.headers), body: String(init?.body ?? '') })
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      })
      const origin = baseOrigin('https://hooks.example/resume', { [CB_AUTH_TOKEN_KEY]: TOKEN })
      const result = await httpPlugin.resume(
        origin,
        { decision: 'accept' },
        { plugin: 'http', resumeSecret: SECRET },
      )
      assert.equal(result.status, 200)
      assert.equal(containsSecretValue(result.resumeData, TOKEN), false)
      assert.equal(containsSecretValue(result.body, TOKEN), false)
      assert.equal(fetches.length, 1)
      assert.equal(fetches[0]!.headers.get('authorization'), `Bearer ${TOKEN}`)
      assert.equal(containsSecretValue(JSON.parse(fetches[0]!.body), TOKEN), false)
      const posted = JSON.parse(fetches[0]!.body)
      assert.equal(posted.decision, 'accept')
      assert.equal(posted.id, 'apr_1')
      assert.equal(posted.metadata.pageId, 'p1')
      assert.ok(posted.event_id)
      assert.equal(posted.type, 'decided')
      mock.restoreAll()
    })
  })

  describe('encryption-at-rest contract', () => {
    it('token lives only under cbAuthToken on the origin handle', () => {
      const env = httpPlugin.ingest({
        resumeUrl: 'https://hooks.example/resume',
        runId: 'r1',
        cbAuthToken: TOKEN,
        metadata: { keep: true },
      })
      assert.equal(env.origin.resumeHandle[CB_AUTH_TOKEN_KEY], TOKEN)
      const publicProjection = redactSecrets(env.origin.resumeHandle)
      assert.equal(containsSecretValue(publicProjection, TOKEN), false)
      assert.equal((publicProjection as any).metadata.keep, true)
    })
  })

  describe('default single POST vs lifecycle opt-in', () => {
    it('default resume sends exactly one decided POST', async () => {
      let hits = 0
      mock.method(globalThis, 'fetch', async () => {
        hits++
        return new Response('{}', { status: 200 })
      })
      await httpPlugin.resume(baseOrigin('https://hooks.example/resume'), { decision: 'reject', reason: 'no' })
      assert.equal(hits, 1)
      mock.restoreAll()
    })

    it('lifecycle delivery no-ops when not opted in', async () => {
      let hits = 0
      mock.method(globalThis, 'fetch', async () => {
        hits++
        return new Response('{}', { status: 200 })
      })
      const out = await deliverHttpLifecycleEvent({
        origin: baseOrigin('https://hooks.example/resume'),
        type: 'presented',
      })
      assert.equal(out, null)
      assert.equal(hits, 0)
      mock.restoreAll()
    })

    it('lifecycle delivery fires when opted in', async () => {
      const bodies: string[] = []
      mock.method(globalThis, 'fetch', async (_u: any, init?: any) => {
        bodies.push(String(init?.body ?? '') )
        return new Response('{}', { status: 200 })
      })
      const out = await deliverHttpLifecycleEvent({
        origin: baseOrigin('https://hooks.example/resume', { lifecycleEvents: ['presented', 'expired'] }),
        type: 'presented',
        credentials: { plugin: 'http', resumeSecret: SECRET },
      })
      assert.ok(out)
      assert.equal(out!.status, 200)
      const posted = JSON.parse(bodies[0]!)
      assert.equal(posted.type, 'presented')
      assert.ok(posted.event_id)
      mock.restoreAll()
    })
  })

  describe('typed answer payloads', () => {
    it('buildDecidedBody carries typed answer and answered type', () => {
      const body = buildDecidedBody({
        eventId: 'evt_ans',
        origin: baseOrigin('https://hooks.example/r'),
        payload: {
          decision: 'respond',
          answer: { kind: 'single_choice', value: 'blue' },
        },
        approvalId: 'apr_q',
        asAnswered: true,
      })
      assert.equal(body.type, 'answered')
      assert.deepEqual(body.answer, { kind: 'single_choice', value: 'blue' })
      assert.equal(body.decision, 'respond')
    })

    it('resume posts answer when provided on payload', async () => {
      let posted: any
      mock.method(globalThis, 'fetch', async (_u: any, init?: any) => {
        posted = JSON.parse(String(init?.body ?? ''))
        return new Response('{}', { status: 200 })
      })
      await httpPlugin.resume(baseOrigin('https://hooks.example/resume'), {
        decision: 'respond',
        answer: { kind: 'free_text', value: 'ship it' },
      } as DecisionPayload)
      assert.equal(posted.type, 'answered')
      assert.deepEqual(posted.answer, { kind: 'free_text', value: 'ship it' })
      mock.restoreAll()
    })

    it('editedArgs travel only in decision payload', async () => {
      let posted: any
      mock.method(globalThis, 'fetch', async (_u: any, init?: any) => {
        posted = JSON.parse(String(init?.body ?? ''))
        return new Response('{}', { status: 200 })
      })
      await httpPlugin.resume(baseOrigin('https://hooks.example/resume'), {
        decision: 'accept',
        editedArgs: { amount: 50 },
      })
      assert.deepEqual(posted.editedArgs, { amount: 50 })
      assert.deepEqual(posted.decisionDetail.editedArgs, { amount: 50 })
      mock.restoreAll()
    })
  })

  describe('retries, backoff, event-id dedupe, SSRF on retry', () => {
    it('retries 5xx with backoff and reuses the same event-id', async () => {
      const sleeps: number[] = []
      const eventIds: string[] = []
      let n = 0
      mock.method(globalThis, 'fetch', async (_u: any, init?: any) => {
        n++
        const headers = new Headers(init?.headers)
        eventIds.push(headers.get('x-hitly-event-id') ?? '')
        if (n < 3) return new Response('nope', { status: 503 })
        return new Response('{}', { status: 200 })
      })
      const result = await deliverHttpCallback({
        resumeUrl: 'https://hooks.example/resume',
        rawBody: JSON.stringify({ decision: 'accept', event_id: 'evt_stable' }),
        eventId: 'evt_stable',
        signingSecret: SECRET,
        backoffMs: [0, 10, 20],
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      })
      assert.equal(result.response.status, 200)
      assert.equal(result.attempts, 3)
      assert.deepEqual(sleeps, [10, 20])
      assert.deepEqual(eventIds, ['evt_stable', 'evt_stable', 'evt_stable'])
      mock.restoreAll()
    })

    it('does not retry destination refusals', async () => {
      setDestinationCheckTestHooks({
        resolve: async () => [{ address: '127.0.0.1' }],
        transport: globalFetchTransport,
      })
      const prev = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      delete process.env.HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS
      let fetches = 0
      mock.method(globalThis, 'fetch', async () => {
        fetches++
        return new Response('{}', { status: 200 })
      })
      await assert.rejects(
        () =>
          deliverHttpCallback({
            resumeUrl: 'https://localhost/resume',
            rawBody: '{}',
            eventId: 'evt_x',
            backoffMs: [0, 1, 1],
            sleep: async () => {},
          }),
        (err: unknown) => err instanceof DestinationCheckError && (err as DestinationCheckError).code === 'refused',
      )
      assert.equal(fetches, 0)
      process.env.NODE_ENV = prev
      setDestinationCheckTestHooks({
        resolve: async () => [{ address: '203.0.113.10' }],
        transport: globalFetchTransport,
      })
      mock.restoreAll()
    })

    it('sends Bearer + HMAC on every attempt', async () => {
      const auths: Array<string | null> = []
      const sigs: Array<string | null> = []
      let n = 0
      mock.method(globalThis, 'fetch', async (_u: any, init?: any) => {
        n++
        const h = new Headers(init?.headers)
        auths.push(h.get('authorization'))
        sigs.push(h.get('x-hitly-signature'))
        if (n === 1) return new Response('x', { status: 502 })
        return new Response('{}', { status: 200 })
      })
      await deliverHttpCallback({
        resumeUrl: 'https://hooks.example/resume',
        rawBody: '{"ok":1}',
        eventId: 'evt_1',
        cbAuthToken: TOKEN,
        signingSecret: SECRET,
        backoffMs: [0, 1],
        sleep: async () => {},
      })
      assert.deepEqual(auths, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`])
      assert.equal(sigs[0]?.length, 64)
      assert.equal(sigs[1]?.length, 64)
      mock.restoreAll()
    })
  })
})
