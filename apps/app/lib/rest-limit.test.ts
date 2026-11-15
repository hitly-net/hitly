/**
 * Unit tests for the shared REST /api/v1 limiter wrapper: 429 shape,
 * Retry-After seconds, hashed subjects, and the fixed log line. No database
 * required — the acquirer is injected.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyRestLimit, apiKeyRestSubject, clientAddressRestSubject, hashRestSubject, restLimitedLog } from './rest-limit'
import { hashApiKey } from './keys'

const decision = (allowed: boolean, retryAfterMs = 0, count = allowed ? 1 : 601) => ({ allowed, retryAfterMs, count })

describe('REST shared limiter', () => {
  it('allows within budget and answers nothing', async () => {
    assert.equal(await applyRestLimit('read', 'subject', () => decision(true)), null)
  })

  it('over budget answers 429 with Retry-After seconds and a body', async () => {
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (line?: unknown) => void warnings.push(String(line))
    try {
      const response = await applyRestLimit('read', 'subject', () => decision(false, 45_000))
      assert.ok(response)
      assert.equal(response.status, 429)
      assert.equal(response.headers.get('retry-after'), '45')
      const body = (await response.json()) as { error?: string }
      assert.equal(body.error, 'too_many_requests')
      assert.deepEqual(warnings, [restLimitedLog('read')])
    } finally {
      console.warn = warn
    }
  })

  it('sub-second waits still answer a whole second', async () => {
    const response = await applyRestLimit('write', 'subject', () => decision(false, 200))
    assert.ok(response)
    assert.equal(response.headers.get('retry-after'), '1')
  })

  it('API key subjects are SHA-256 only — the raw key never reaches the limiter', async () => {
    const key = 'hitly_' + 'b'.repeat(32)
    const seen: string[] = []
    const response = await applyRestLimit('read', apiKeyRestSubject(key), (subject) => {
      seen.push(subject)
      return decision(true)
    })
    assert.equal(response, null)
    assert.deepEqual(seen, [hashApiKey(key)])
    assert.notEqual(seen[0], key)
  })

  it('capability subjects are hashed and stable', () => {
    assert.equal(hashRestSubject('tok'), hashRestSubject('tok'))
    assert.match(hashRestSubject('tok'), /^[0-9a-f]{64}$/)
    assert.notEqual(hashRestSubject('tok'), hashRestSubject('tok2'))
  })

  it('anonymous subjects key on the client-address key, never a raw secret', async () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.9' })
    const subject = clientAddressRestSubject(headers)
    assert.ok(subject.startsWith('addr:'))
    const seen: string[] = []
    await applyRestLimit('read', subject, (s) => {
      seen.push(s)
      return decision(true)
    })
    assert.deepEqual(seen, [subject])
  })
})

describe('default-limit pins (M2)', () => {
  it('every family default is pinned; changing a shipped default breaks this test', async () => {
    const mod = await import('./rest-limit')
    assert.equal(mod.REST_READ_LIMIT, 600)
    assert.equal(mod.REST_READ_WINDOW_MS, 60_000)
    assert.equal(mod.REST_WRITE_LIMIT, 120)
    assert.equal(mod.REST_WRITE_WINDOW_MS, 60_000)
    assert.equal(mod.INVITE_LIMIT, 30)
    assert.equal(mod.INVITE_WINDOW_MS, 60_000)
    assert.equal(mod.FAILED_AUTH_LIMIT, 60)
    assert.equal(mod.FAILED_AUTH_WINDOW_MS, 60_000)
    const ingest = await import('./ingest-route')
    assert.equal(ingest.INGEST_LIMIT, 120)
    assert.equal(ingest.INGEST_WINDOW_MS, 60_000)
    const mfa = await import('./mfa-limit')
    assert.equal(mfa.MFA_VERIFY_ATTEMPT_LIMIT, 10)
    assert.equal(mfa.MFA_VERIFY_ATTEMPT_WINDOW_MS, 15 * 60 * 1000)
  })
})

describe('failed-auth budget (M5)', () => {
  it('applyFailedAuthLimit counts the client address and answers 429 with Retry-After', async () => {
    const { applyFailedAuthLimit } = await import('./rest-limit')
    const seen: string[] = []
    const request = new Request('http://localhost:3001/api/v1/approvals', {
      headers: { 'x-forwarded-for': '203.0.113.77' },
    })
    const ok = await applyFailedAuthLimit(request, (subject) => {
      seen.push(subject)
      return decision(true)
    })
    assert.equal(ok, null)
    assert.equal(seen.length, 1)
    assert.match(seen[0]!, /^addr:/)
    const blocked = await applyFailedAuthLimit(request, () => decision(false, 59_000))
    assert.ok(blocked)
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers.get('retry-after'), '59')
  })

  it('a presented key is NEVER used as a failed-auth subject', async () => {
    const { applyFailedAuthLimit } = await import('./rest-limit')
    const key = 'hitly_' + 'c'.repeat(32)
    const seen: string[] = []
    const request = new Request('http://localhost:3001/api/v1/approvals', {
      headers: { 'x-forwarded-for': '203.0.113.78', authorization: `Bearer ${key}` },
    })
    await applyFailedAuthLimit(request, (subject) => {
      seen.push(subject)
      return decision(true)
    })
    assert.notEqual(seen[0], key)
    assert.notEqual(seen[0], hashApiKey(key))
  })
})

describe('key format gate (M5)', () => {
  it('isWellFormedApiKey accepts only the generateApiKey shape', async () => {
    const { isWellFormedApiKey } = await import('./keys')
    assert.equal(isWellFormedApiKey('hitly_' + 'a'.repeat(32)), true)
    assert.equal(isWellFormedApiKey('hitly_short'), false)
    assert.equal(isWellFormedApiKey('nope_' + 'a'.repeat(32)), false)
    assert.equal(isWellFormedApiKey('hitly_' + 'a'.repeat(31)), false)
    assert.equal(isWellFormedApiKey('hitly_' + 'a'.repeat(32) + 'x'), false)
    assert.equal(isWellFormedApiKey(''), false)
    assert.equal(isWellFormedApiKey('hitly_' + 'a'.repeat(31) + '!'), false)
  })
})

describe('HITLY_RATE_LIMIT_DB wiring (M2)', () => {
  it('the env flag decides whether the shared table is used', async () => {
    const { rateLimitDbEnabled } = await import('./rate-limit')
    assert.equal(rateLimitDbEnabled({}), true)
    assert.equal(rateLimitDbEnabled({ HITLY_RATE_LIMIT_DB: '1' }), true)
    assert.equal(rateLimitDbEnabled({ HITLY_RATE_LIMIT_DB: '0' }), false)
    assert.equal(rateLimitDbEnabled({ HITLY_RATE_LIMIT_DB: ' 0 ' }), false)
    assert.equal(rateLimitDbEnabled({ HITLY_RATE_LIMIT_DB: 'off' }), true, 'only 0 disables')
  })

  it('the app limiter counts through the app pool (source pin)', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('./rate-limit.ts', import.meta.url), 'utf8')
    assert.match(src, /pool:\s*pool && rateLimitDbEnabled\(\)/, 'the shared limiter is wired to the app pool behind the env flag')
  })
})
