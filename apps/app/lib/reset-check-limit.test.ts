import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addressLimitKey, trustedProxyCount } from './client-address'
import {
  RESET_CHECK_LIMIT,
  RESET_CHECK_SHARED_LIMIT,
  UNKNOWN_CLIENT_KEY,
  createRateLimiter,
  createResetCheckLimiter,
  resetCheckClientKey,
} from './reset-check-limit'

/**
 * Reset-check limiter details: the shared ceiling for requests with no client
 * address, IPv6 keying, the proxy count bounds, and expiry order.
 * Addresses are from the documentation ranges.
 */

describe('requests with no client address', () => {
  it('share a ceiling far above the per-client limit', () => {
    const allow = createResetCheckLimiter({ now: () => 0 })
    for (let i = 0; i < RESET_CHECK_SHARED_LIMIT; i += 1) assert.equal(allow(UNKNOWN_CLIENT_KEY), true, `request ${i + 1}`)
    assert.equal(allow(UNKNOWN_CLIENT_KEY), false)
    assert.ok(RESET_CHECK_SHARED_LIMIT >= 10 * RESET_CHECK_LIMIT)
  })

  it('keeps the per-client limit for real addresses', () => {
    const allow = createResetCheckLimiter({ limit: 2, sharedLimit: 100, now: () => 0 })
    assert.equal(allow('198.51.100.1'), true)
    assert.equal(allow('198.51.100.1'), true)
    assert.equal(allow('198.51.100.1'), false)
    assert.equal(allow(UNKNOWN_CLIENT_KEY), true)
  })

  it('a count of 0 gives the unknown key', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.5, 198.51.100.1' })
    assert.equal(resetCheckClientKey(headers, { trustedProxies: 0 }), UNKNOWN_CLIENT_KEY)
  })
})

describe('IPv6 keying', () => {
  it('keys IPv6 clients on their /64', () => {
    assert.equal(addressLimitKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64')
    assert.equal(addressLimitKey('2001:db8:1:2::1'), '2001:db8:1:2::/64')
    assert.equal(addressLimitKey('2001:DB8:0001:0002::ffff'), '2001:db8:1:2::/64')
    assert.equal(addressLimitKey('2001:db8::1'), '2001:db8:0:0::/64')
    assert.equal(addressLimitKey('fe80::1%eth0'), 'fe80:0:0:0::/64')
  })

  it('keeps IPv4 and unwraps IPv4-mapped IPv6', () => {
    assert.equal(addressLimitKey('198.51.100.1'), '198.51.100.1')
    assert.equal(addressLimitKey('::ffff:198.51.100.1'), '198.51.100.1')
    assert.equal(addressLimitKey('::ffff:c633:6401'), '198.51.100.1')
  })

  it('limits a client that rotates addresses inside its /64', () => {
    const allow = createRateLimiter({ limit: 3, windowMs: 60_000 })
    const results: boolean[] = []
    for (let i = 1; i <= 4; i += 1) {
      const headers = new Headers({ 'x-forwarded-for': `2001:db8:1:2::${i.toString(16)}` })
      results.push(allow(resetCheckClientKey(headers, { trustedProxies: 1 })))
    }
    assert.deepEqual(results, [true, true, true, false])
  })
})

describe('HITLY_TRUSTED_PROXY_COUNT bounds', () => {
  it('parses 0 to 5, caps above 5 and defaults otherwise', () => {
    const count = (value: string) => trustedProxyCount({ HITLY_TRUSTED_PROXY_COUNT: value })
    assert.equal(count('0'), 0)
    assert.equal(count('1'), 1)
    assert.equal(count('5'), 5)
    assert.equal(count('6'), 5)
    assert.equal(count('99999999999999999999'), 5)
    for (const bad of ['-1', '-0', 'abc', '2x', '0x2', '1.0', '']) assert.equal(count(bad), 1, bad)
  })
})

describe('limiter expiry order', () => {
  it('a client whose window restarts moves to the back of the eviction order', () => {
    let time = 0
    const allow = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 3, now: () => time })
    assert.equal(allow('a'), true) // a: window until 1000
    time = 500
    assert.equal(allow('b'), true) // b: window until 1500
    time = 1100
    assert.equal(allow('a'), true) // a restarts: window until 2100
    assert.equal(allow('a'), false)
    time = 1200
    assert.equal(allow('c'), true) // table now full
    time = 1300
    assert.equal(allow('d'), true) // evicts b (the oldest window), not a
    assert.equal(allow('a'), false, 'a keeps its count')
    assert.equal(allow('b'), true, 'b was evicted')
  })
})
