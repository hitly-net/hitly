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
