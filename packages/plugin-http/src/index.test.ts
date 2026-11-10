import { describe, it, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash, createHmac } from 'node:crypto'
import type { DecisionPayload, OriginRef } from '@hitly/core'
import { DestinationCheckError, globalFetchTransport, setDestinationCheckTestHooks } from '@hitly/core/destination-check'
import {
  buildDecidedBody,
  buildLifecycleBody,
  buildSignatureHeaders,
  containsSecretValue,
  DEFAULT_BACKOFF_MS,
  deliverHttpCallback,
  deliverHttpLifecycleEvent,
  deterministicEventId,
  HEADER_EVENT_ID,
  HEADER_KEY_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  httpPlugin,
  parseLifecycleEvents,
  pickActiveSigningKey,
  redactSecrets,
  resolveSigningKey,
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

/**
 * The webhook signing registry as stored on a project (item 9): callbacks are
 * signed with a DEDICATED per-project webhook secret + key id, never with the
 * resume secret (HITLY_RESUME_SECRET on the origin side).
 */
function webhookCredentials(secret = SECRET, keyId = 'whk_m0h_active'): Record<string, unknown> {
  return {
    webhookSigningSecrets: [{ keyId, secret, createdAt: 1_735_000_000, validUntil: null }],
  }
}

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
    it('requires runId; resumeUrl is optional (no callback without it)', () => {
      // No resumeUrl: accepted, and none is stored (rule: no callback_url =>
      // HITLy attempts NO callback). resume() skips delivery entirely.
      const env = httpPlugin.ingest({ runId: 'r1' })
      assert.equal('resumeUrl' in (env.origin.resumeHandle as Record<string, unknown>), false)
      assert.throws(() => httpPlugin.ingest({ resumeUrl: 'https://example.com/cb' }), /runId/)
      assert.throws(() => httpPlugin.ingest({ resumeUrl: 'https://example.com/cb', runId: '   ' }), /runId/)
    })

    it('stores no resumeUrl for blank values and keeps it for real ones', () => {
      const blank = httpPlugin.ingest({ runId: 'r1', resumeUrl: '   ' })
      assert.equal('resumeUrl' in (blank.origin.resumeHandle as Record<string, unknown>), false)
      const real = httpPlugin.ingest({ runId: 'r1', resumeUrl: 'https://example.com/cb' })
      assert.equal(real.origin.resumeHandle.resumeUrl, 'https://example.com/cb')
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
        { plugin: 'http', ...webhookCredentials() },
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

    it('resume() with no stored resumeUrl performs zero outbound calls', async () => {
      // Created without callback_url: the decision must complete with NO
      // callback attempt at all (no POST, no auth, no HMAC), never failed_resume.
      let hits = 0
      mock.method(globalThis, 'fetch', async () => {
        hits++
        return new Response('{}', { status: 200 })
      })
      const env = httpPlugin.ingest({ runId: 'run_nc', actionName: 'pay' })
      const origin: OriginRef = { ...env.origin, resumeHandle: { ...env.origin.resumeHandle, approvalId: 'apr_nc' } }
      const decided = await httpPlugin.resume(origin, { decision: 'accept' })
      assert.equal(decided, undefined, 'resume is skipped entirely (void = no resume error)')
      // The ask_user answer path is skipped the same way.
      const answered = await httpPlugin.resume(origin, { decision: 'respond', response: 'Saturday', answer: 'Saturday' })
      assert.equal(answered, undefined)
      assert.equal(hits, 0, 'not a single outbound request')
      mock.restoreAll()
    })

    it('lifecycle delivery no-ops without a stored resumeUrl even when opted in', async () => {
      let hits = 0
      mock.method(globalThis, 'fetch', async () => {
        hits++
        return new Response('{}', { status: 200 })
      })
      const env = httpPlugin.ingest({ runId: 'run_nc2', lifecycleEvents: ['presented'] })
      assert.equal('resumeUrl' in (env.origin.resumeHandle as Record<string, unknown>), false)
      const out = await deliverHttpLifecycleEvent({
        origin: { ...env.origin, resumeHandle: { ...env.origin.resumeHandle, approvalId: 'apr_nc2' } },
        type: 'presented',
      })
      assert.equal(out, null)
      assert.equal(hits, 0)
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
        credentials: { plugin: 'http', ...webhookCredentials() },
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

    // PM ruling on hitl-spec 4.2 (Test M1): callbacks NEVER carry `answer: null` -
    // with no answer the key is omitted entirely (also on lifecycle bodies).
    it('buildDecidedBody omits the answer key when there is no answer', () => {
      const body = buildDecidedBody({
        eventId: 'evt_noans',
        origin: baseOrigin('https://hooks.example/r'),
        payload: { decision: 'accept' },
        approvalId: 'apr_a',
      })
      assert.equal(body.type, 'decided')
      assert.equal('answer' in body, false, 'no answer means no answer key, never answer: null')
    })

    it('buildDecidedBody treats a stored literal null answer as absent', () => {
      const body = buildDecidedBody({
        eventId: 'evt_nullans',
        origin: baseOrigin('https://hooks.example/r'),
        payload: { decision: 'respond', answer: null },
        approvalId: 'apr_n',
      })
      assert.equal('answer' in body, false, 'a stored null must not surface as answer: null')
    })

    it('buildLifecycleBody never carries an answer key', () => {
      const body = buildLifecycleBody({ eventId: 'evt_lc', type: 'presented', approvalId: 'apr_l' })
      assert.equal('answer' in body, false, 'lifecycle events carry no answer key')
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
      // Jittered backoff: each sleep is the schedule entry plus up to 25% jitter.
      assert.equal(sleeps.length, 2)
      assert.ok(sleeps[0]! >= 10 && sleeps[0]! <= 13, `first backoff ${sleeps[0]} within [10, 13]`)
      assert.ok(sleeps[1]! >= 20 && sleeps[1]! <= 25, `second backoff ${sleeps[1]} within [20, 25]`)
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

    it('omits the response body after exhausted 5xx retries', async () => {
      const CANARY = 'canary-4b9d2e7f-response-text'
      mock.method(globalThis, 'fetch', async () => new Response(CANARY, { status: 500 }))
      const result = await deliverHttpCallback({
        resumeUrl: 'https://hooks.example/resume',
        rawBody: JSON.stringify({ decision: 'accept' }),
        eventId: 'evt_body_redact',
        backoffMs: [0, 1, 1],
        sleep: async () => {},
      })
      assert.equal(result.attempts, 3)
      assert.equal(result.response.status, 500)
      assert.equal(result.response.body, null)
      assert.ok(result.response.error?.includes('failed (500)'))
      const shown = JSON.stringify(result.response)
      assert.ok(!shown.includes(CANARY), 'response body must never leak the canary')
      mock.restoreAll()
    })
  })

  describe('M3: HMAC pinned by independent verification', () => {
    const KAV_BODY = '{"event_id":"evt_kav","decision":"accept","metadata":{"pageId":"p1"}}'
    const KAV_TS = 1736000000
    // Independently computed (Python hmac, out-of-band) over `"<ts>.<body>"`:
    // if signBody ever signs different bytes or drops the timestamp, this fails.
    const KAV_SIGNATURE = 'e529757b74768c820c5809ebeef054ece05973612c1ce092797ee893750a2c74'
    const KAV_KEY_ID = 'hk_43b95ba5' // hk_ + sha256(secret).hex[:8]

    it('signBody matches the known-answer vector and key-id derivation', () => {
      assert.equal(signBody(SECRET, KAV_TS, KAV_BODY), KAV_SIGNATURE)
      assert.equal(webhookKeyId(SECRET), KAV_KEY_ID)
    })

    it('the wire signature is HMAC over timestamp + "." + the exact bytes sent', async () => {
      const sent: Array<{ body: string; headers: Headers }> = []
      mock.method(globalThis, 'fetch', async (_u: any, init?: any) => {
        sent.push({ body: String(init?.body ?? ''), headers: new Headers(init?.headers) })
        return new Response('{}', { status: 200 })
      })
      try {
        await httpPlugin.resume(
          baseOrigin('https://hooks.example/resume'),
          { decision: 'accept' },
          // Legacy single-string shape: no stored key id, so the derived
          // hk_<sha8> id must be advertised.
          { plugin: 'http', webhookSigningSecret: SECRET },
        )
        assert.equal(sent.length, 1)
        const { body, headers } = sent[0]!
        const ts = headers.get(HEADER_TIMESTAMP)
        assert.ok(ts && /^\d+$/.test(ts), 'timestamp header is unix seconds')
        // Recompute with raw node:crypto over what was ACTUALLY sent: catches
        // MU01 (signature computed over different bytes than sent) and
        // MU02 (timestamp dropped from the signed string).
        const recomputed = createHmac('sha256', SECRET).update(`${ts}.${body}`, 'utf8').digest('hex')
        assert.equal(headers.get(HEADER_SIGNATURE), recomputed)
        assert.equal(
          headers.get(HEADER_KEY_ID),
          'hk_' + createHash('sha256').update(SECRET, 'utf8').digest('hex').slice(0, 8),
        )
        const bodyOnly = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')
        assert.notEqual(headers.get(HEADER_SIGNATURE), bodyOnly, 'body-only HMAC must not match')
        assert.equal(headers.get(HEADER_EVENT_ID), JSON.parse(body).event_id)
      } finally {
        mock.restoreAll()
      }
    })

    it('lifecycle deliveries carry the same independent signature over their sent bytes', async () => {
      const sent: Array<{ body: string; headers: Headers }> = []
      mock.method(globalThis, 'fetch', async (_u: any, init?: any) => {
        sent.push({ body: String(init?.body ?? ''), headers: new Headers(init?.headers) })
        return new Response('{}', { status: 200 })
      })
      try {
        await deliverHttpLifecycleEvent({
          origin: baseOrigin('https://hooks.example/resume', { lifecycleEvents: ['presented'] }),
          type: 'presented',
          credentials: { plugin: 'http', ...webhookCredentials() },
        })
        assert.equal(sent.length, 1)
        const { body, headers } = sent[0]!
        const ts = headers.get(HEADER_TIMESTAMP)!
        const recomputed = createHmac('sha256', SECRET).update(`${ts}.${body}`, 'utf8').digest('hex')
        assert.equal(headers.get(HEADER_SIGNATURE), recomputed)
      } finally {
        mock.restoreAll()
      }
    })
  })

  describe('M4: destination check pinned on every attempt and lifecycle', () => {
    const prod = (fn: () => Promise<void>) => {
      const prev = process.env.NODE_ENV
      const prevFlag = process.env.HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS
      process.env.NODE_ENV = 'production'
      delete process.env.HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS
      return fn().finally(() => {
        process.env.NODE_ENV = prev
        if (prevFlag === undefined) delete process.env.HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS
        else process.env.HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS = prevFlag
        setDestinationCheckTestHooks({
          resolve: async () => [{ address: '203.0.113.10' }],
          transport: globalFetchTransport,
        })
      })
    }

    it('refuses a retry whose re-resolved address flips to private, without a second connect', () => {
      let resolveCalls = 0
      let connects = 0
      setDestinationCheckTestHooks({
        resolve: async () => {
          resolveCalls++
          // DNS-rebinding shape: attempt 1 public, attempt 2+ private.
          return resolveCalls === 1 ? [{ address: '203.0.113.10' }] : [{ address: '127.0.0.1' }]
        },
        transport: async () => {
          connects++
          return { status: 503, statusText: 'Unavailable', headers: new Headers(), body: new Uint8Array(0) }
        },
      })
      return prod(async () => {
        await assert.rejects(
          () =>
            deliverHttpCallback({
              resumeUrl: 'https://hooks.example/resume',
              rawBody: '{"decision":"accept"}',
              eventId: 'evt_ssrf_flip',
              backoffMs: [0, 1, 1],
              sleep: async () => {},
            }),
          (err: unknown) => err instanceof DestinationCheckError && (err as DestinationCheckError).code === 'refused',
        )
        assert.equal(connects, 1, 'the flipped-private retry must be refused before any connect (MU09)')
        assert.ok(resolveCalls >= 2, 'each attempt re-resolves (no cached destination)')
      })
    })

    it('refuses a lifecycle delivery to a metadata address in production (MU10)', () => {
      let connects = 0
      setDestinationCheckTestHooks({
        resolve: async () => [{ address: '169.254.169.254' }],
        transport: async () => {
          connects++
          return { status: 200, statusText: 'OK', headers: new Headers(), body: new Uint8Array(0) }
        },
      })
      return prod(async () => {
        await assert.rejects(
          () =>
            deliverHttpLifecycleEvent({
              origin: baseOrigin('https://metadata.example/resume', { lifecycleEvents: ['presented'] }),
              type: 'presented',
              credentials: { plugin: 'http', ...webhookCredentials() },
            }),
          (err: unknown) => err instanceof DestinationCheckError && (err as DestinationCheckError).code === 'refused',
        )
        assert.equal(connects, 0, 'a refused lifecycle destination must never connect')
      })
    })
  })

  describe('M5: event-id dedupe across host retries', () => {
    const captureResume = async (origin: OriginRef, payload: DecisionPayload): Promise<any> => {
      let posted: any
      let headerId: string | null = null
      mock.method(globalThis, 'fetch', async (_u: any, init?: any) => {
        posted = JSON.parse(String(init?.body ?? ''))
        headerId = new Headers(init?.headers).get(HEADER_EVENT_ID)
        return new Response('{}', { status: 200 })
      })
      try {
        await httpPlugin.resume(origin, payload)
      } finally {
        mock.restoreAll()
      }
      return { posted, headerId }
    }

    it('two resumes for the same approval (decide + retryResume) reuse the event id', async () => {
      const origin = baseOrigin('https://hooks.example/resume') // approvalId apr_1
      const first = await captureResume(origin, { decision: 'accept' })
      const second = await captureResume(origin, { decision: 'accept' })
      assert.match(first.posted.event_id, /^evt_[0-9a-f]{32}$/)
      assert.equal(second.posted.event_id, first.posted.event_id, 'retryResume must reuse the event id')
      assert.equal(first.headerId, first.posted.event_id)
      assert.equal(second.headerId, first.posted.event_id, 'header and body dedupe key agree')
    })

    it('answered and decided are distinct logical deliveries, each stable', async () => {
      const origin = baseOrigin('https://hooks.example/resume')
      const decided = await captureResume(origin, { decision: 'accept' })
      const answered = await captureResume(origin, { decision: 'respond', answer: { value: 'yes' } } as DecisionPayload)
      const answeredAgain = await captureResume(
        origin,
        { decision: 'respond', answer: { value: 'yes' } } as DecisionPayload,
      )
      assert.notEqual(answered.posted.event_id, decided.posted.event_id)
      assert.equal(answered.posted.event_id, answeredAgain.posted.event_id)
    })

    it('a stored deliveryEventIds entry wins over derivation', async () => {
      const origin = baseOrigin('https://hooks.example/resume', {
        deliveryEventIds: { decided: 'evt_persisted_by_host' },
      })
      const first = await captureResume(origin, { decision: 'accept' })
      assert.equal(first.posted.event_id, 'evt_persisted_by_host')
    })

    it('deterministicEventId is stable per approval+key and differs across them', () => {
      const a = deterministicEventId('apr_1', 'decided')
      assert.equal(a, deterministicEventId('apr_1', 'decided'))
      assert.equal(a, 'evt_' + createHash('sha256').update('hitly:http:v1:apr_1:decided', 'utf8').digest('hex').slice(0, 32))
      assert.notEqual(a, deterministicEventId('apr_2', 'decided'))
      assert.notEqual(a, deterministicEventId('apr_1', 'presented'))
    })
  })

  describe('retry policy: transient codes retried, 4xx never, attempts capped', () => {
    it('retries transient connect/timeout failures to the end of the schedule', async () => {
      const codes = ['connect', 'timeout'] as const
      let calls = 0
      setDestinationCheckTestHooks({
        resolve: async () => [{ address: '203.0.113.10' }],
        transport: async () => {
          const code = codes[calls % codes.length]!
          calls++
          throw new DestinationCheckError(code, `Destination check: simulated ${code} (host "hooks.example").`, 'hooks.example')
        },
      })
      try {
        const result = await deliverHttpCallback({
          resumeUrl: 'https://hooks.example/resume',
          rawBody: '{"decision":"accept"}',
          eventId: 'evt_transient',
          backoffMs: [0, 1, 1],
          sleep: async () => {},
        })
        assert.equal(calls, 3, 'connect/timeout are transient: all attempts run (S3/MU08 shape)')
        assert.equal(result.attempts, 3)
        assert.equal(result.response.status, 0)
        assert.equal(result.response.body, null)
        assert.ok(result.response.error?.includes('simulated'))
      } finally {
        setDestinationCheckTestHooks({
          resolve: async () => [{ address: '203.0.113.10' }],
          transport: globalFetchTransport,
        })
      }
    })

    for (const retryable of [408, 425, 429]) {
      it(`retries ${retryable} up to the attempt cap`, async () => {
        let calls = 0
        setDestinationCheckTestHooks({
          resolve: async () => [{ address: '203.0.113.10' }],
          transport: async () => {
            calls++
            return { status: retryable, statusText: 'Retry', headers: new Headers(), body: new TextEncoder().encode('nope') }
          },
        })
        try {
          const result = await deliverHttpCallback({
            resumeUrl: 'https://hooks.example/resume',
            rawBody: '{"decision":"accept"}',
            eventId: 'evt_retryable',
            backoffMs: [0, 1, 1],
            sleep: async () => {},
          })
          assert.equal(calls, 3)
          assert.equal(result.attempts, 3)
          assert.equal(result.response.status, retryable)
          assert.equal(result.response.body, null)
        } finally {
          setDestinationCheckTestHooks({
            resolve: async () => [{ address: '203.0.113.10' }],
            transport: globalFetchTransport,
          })
        }
      })
    }

    for (const refusal of [400, 401, 403, 404]) {
      it(`never retries ${refusal}: exactly one attempt, no body (MU12)`, async () => {
        let calls = 0
        setDestinationCheckTestHooks({
          resolve: async () => [{ address: '203.0.113.10' }],
          transport: async () => {
            calls++
            return {
              status: refusal,
              statusText: 'Denied',
              headers: new Headers(),
              body: new TextEncoder().encode('canary-mu12-body'),
            }
          },
        })
        try {
          const result = await deliverHttpCallback({
            resumeUrl: 'https://hooks.example/resume',
            rawBody: '{"decision":"accept"}',
            eventId: 'evt_no_retry_4xx',
            backoffMs: [0, 1, 1],
            sleep: async () => {},
          })
          assert.equal(calls, 1, '4xx must not be retried')
          assert.equal(result.attempts, 1)
          assert.equal(result.response.status, refusal)
          assert.equal(result.response.body, null)
          assert.ok(!JSON.stringify(result.response).includes('canary-mu12-body'))
        } finally {
          setDestinationCheckTestHooks({
            resolve: async () => [{ address: '203.0.113.10' }],
            transport: globalFetchTransport,
          })
        }
      })
    }

    it('attempts are capped at the schedule length (MU08)', async () => {
      assert.ok(Array.isArray(DEFAULT_BACKOFF_MS) && DEFAULT_BACKOFF_MS.length === 3, 'default schedule is bounded')
      assert.ok(DEFAULT_BACKOFF_MS.every((ms) => Number.isFinite(ms) && ms >= 0))
      let calls = 0
      setDestinationCheckTestHooks({
        resolve: async () => [{ address: '203.0.113.10' }],
        transport: async () => {
          calls++
          return { status: 503, statusText: 'Unavailable', headers: new Headers(), body: new Uint8Array(0) }
        },
      })
      try {
        const result = await deliverHttpCallback({
          resumeUrl: 'https://hooks.example/resume',
          rawBody: '{"decision":"accept"}',
          eventId: 'evt_cap',
          backoffMs: [0, 1, 1, 1, 1],
          sleep: async () => {},
        })
        assert.equal(calls, 5, 'loop must stop at backoffMs.length')
        assert.equal(result.attempts, 5)
        assert.equal(result.response.status, 503)
      } finally {
        setDestinationCheckTestHooks({
          resolve: async () => [{ address: '203.0.113.10' }],
          transport: globalFetchTransport,
        })
      }
    })
  })

  describe('M6: per-project webhook signing secret (not the resume secret) with rotation overlap', () => {
    const RESUME_SECRET = 'hitly_resume_NEVER_sign_callbacks_with_me'
    const OLD_SECRET = 'whsec_old_before_rotation'
    const NEW_SECRET = 'whsec_new_after_rotation'

    it('resolveSigningKey uses the webhook registry and never the resume secret', () => {
      const now = 1_800_000_000
      const creds = {
        resumeSecret: RESUME_SECRET,
        webhookSigningSecrets: [
          { keyId: 'whk_old', secret: OLD_SECRET, createdAt: 100, validUntil: null },
          { keyId: 'whk_new', secret: NEW_SECRET, createdAt: 200, validUntil: null },
        ],
      }
      const key = resolveSigningKey(creds, now)
      assert.equal(key?.secret, NEW_SECRET, 'newest usable webhook key signs')
      assert.equal(key?.keyId, 'whk_new')
      // A project with only a resume secret signs NOTHING: the resume secret
      // authenticates origin->HITLy polls, never HITLy->origin callbacks.
      assert.equal(resolveSigningKey({ resumeSecret: RESUME_SECRET }, now), undefined)
      assert.equal(resolveSigningKey(undefined, now), undefined)
      // All webhook keys rotated out => sign nothing; never fall through to resumeSecret.
      assert.equal(
        resolveSigningKey(
          {
            resumeSecret: RESUME_SECRET,
            webhookSigningSecrets: [{ keyId: 'whk_gone', secret: OLD_SECRET, createdAt: 1, validUntil: now - 1 }],
          },
          now,
        ),
        undefined,
        'expired registry must not sign, and must not fall back to the resume secret',
      )
      assert.equal(pickActiveSigningKey([], now), null)
    })

    it('the wire signature uses the webhook secret + stored key id, not the resume secret', async () => {
      const sent: Array<{ body: string; headers: Headers }> = []
      mock.method(globalThis, 'fetch', async (_u: any, init?: any) => {
        sent.push({ body: String(init?.body ?? ''), headers: new Headers(init?.headers) })
        return new Response('{}', { status: 200 })
      })
      try {
        await httpPlugin.resume(
          baseOrigin('https://hooks.example/resume'),
          { decision: 'accept' },
          { plugin: 'http', resumeSecret: RESUME_SECRET, ...webhookCredentials(SECRET, 'whk_project_1') },
        )
        assert.equal(sent.length, 1)
        const { body, headers } = sent[0]!
        const ts = headers.get(HEADER_TIMESTAMP)!
        const sig = headers.get(HEADER_SIGNATURE)!
        assert.equal(headers.get(HEADER_KEY_ID), 'whk_project_1', 'stored key id is advertised')
        const webhookHmac = createHmac('sha256', SECRET).update(`${ts}.${body}`, 'utf8').digest('hex')
        assert.equal(sig, webhookHmac, 'signature is HMAC over "<ts>.<body>" with the WEBHOOK secret')
        const resumeHmac = createHmac('sha256', RESUME_SECRET).update(`${ts}.${body}`, 'utf8').digest('hex')
        assert.notEqual(sig, resumeHmac, 'must NOT be signed with the resume secret (HITLY_RESUME_SECRET)')
      } finally {
        mock.restoreAll()
      }
    })

    it('verify accepts a rotated-out key inside the overlap window and refuses it after', () => {
      const now = 1_800_000_000
      const rawBody = '{"decision":"accept"}'
      const keys = [
        { keyId: 'whk_old', secret: OLD_SECRET, createdAt: 100, validUntil: now + 3600 },
        { keyId: 'whk_new', secret: NEW_SECRET, createdAt: 200, validUntil: null },
      ]
      const oldSig = signBody(OLD_SECRET, now, rawBody)

      const inOverlap = verifyHttpSignature({
        keys,
        rawBody,
        timestampHeader: String(now),
        signatureHeader: oldSig,
        keyIdHeader: 'whk_old',
        nowSeconds: now,
      })
      assert.equal(inOverlap.ok, true, 'the rotated-out key still verifies during the overlap window')
      assert.ok(inOverlap.ok && inOverlap.keyId === 'whk_old')

      // Past validUntil the old key is refused; the new key keeps working.
      const later = now + 7200
      assert.equal(
        verifyHttpSignature({
          keys,
          rawBody,
          timestampHeader: String(later),
          signatureHeader: signBody(OLD_SECRET, later, rawBody),
          keyIdHeader: 'whk_old',
          nowSeconds: later,
          maxSkewSeconds: 86_400,
        }).reason,
        'expired_key',
        'overlap window closed: the old key must be refused',
      )
      const okNew = verifyHttpSignature({
        keys,
        rawBody,
        timestampHeader: String(later),
        signatureHeader: signBody(NEW_SECRET, later, rawBody),
        keyIdHeader: 'whk_new',
        nowSeconds: later,
        maxSkewSeconds: 86_400,
      })
      assert.equal(okNew.ok, true)

      assert.equal(
        verifyHttpSignature({
          keys,
          rawBody,
          timestampHeader: String(now),
          signatureHeader: oldSig,
          keyIdHeader: 'whk_unknown',
          nowSeconds: now,
        }).reason,
        'key_mismatch',
      )

      // Legacy senders without a key id: any usable key verifies; a match only
      // on an expired key reports expired_key, not a bare bad_signature.
      const noKeyId = verifyHttpSignature({
        keys,
        rawBody,
        timestampHeader: String(now),
        signatureHeader: oldSig,
        nowSeconds: now,
      })
      assert.equal(noKeyId.ok, true)
      assert.ok(noKeyId.ok && noKeyId.keyId === 'whk_old')
      assert.equal(
        verifyHttpSignature({
          keys: [{ keyId: 'whk_old', secret: OLD_SECRET, createdAt: 100, validUntil: now - 1 }],
          rawBody,
          timestampHeader: String(now),
          signatureHeader: oldSig,
          nowSeconds: now,
        }).reason,
        'expired_key',
      )
    })
  })
})
