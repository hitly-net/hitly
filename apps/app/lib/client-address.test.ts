import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { clientAddress } from './client-address'
import { createRateLimiter, resetCheckClientKey } from './reset-check-limit'
import { TRUSTED_PROXIES_ENV, parseTrustedProxies } from './trusted-proxies'

/**
 * Client address picking with a trusted proxy list (lib/client-address.ts).
 * The count-based behaviour is covered in reset-token-check.test.ts.
 * Addresses are from the documentation ranges.
 */

const xff = (value?: string) => new Headers(value === undefined ? {} : { 'x-forwarded-for': value })
const list = parseTrustedProxies('192.0.2.0/24, 2001:db8:ffff::/48')!

describe('client address with a trusted proxy list', () => {
  it('takes the right-most entry that is not a trusted proxy', () => {
    assert.equal(clientAddress(xff('198.51.100.1, 192.0.2.10'), { trustedProxyList: list }), '198.51.100.1')
    assert.equal(clientAddress(xff('198.51.100.1, 192.0.2.20, 192.0.2.10'), { trustedProxyList: list }), '198.51.100.1')
    assert.equal(clientAddress(xff('2001:db8:1::5, 2001:db8:ffff::1'), { trustedProxyList: list }), '2001:db8:1::5')
  })

  it('ignores client-supplied entries to the left of the client', () => {
    assert.equal(
      clientAddress(xff('203.0.113.5, 203.0.113.6, 198.51.100.1, 192.0.2.10'), { trustedProxyList: list }),
      '198.51.100.1',
    )
  })

  it('a spoofed trusted address on the left does not help the client', () => {
    assert.equal(clientAddress(xff('192.0.2.99, 198.51.100.1, 192.0.2.10'), { trustedProxyList: list }), '198.51.100.1')
  })

  it('uses the socket address when the peer is not a trusted proxy', () => {
    assert.equal(
      clientAddress(xff('203.0.113.5'), { trustedProxyList: list, remoteAddress: '198.51.100.7' }),
      '198.51.100.7',
    )
    assert.equal(
      clientAddress(xff('198.51.100.1'), { trustedProxyList: list, remoteAddress: '192.0.2.10' }),
      '198.51.100.1',
    )
    assert.equal(clientAddress(xff(), { trustedProxyList: list, remoteAddress: '198.51.100.7' }), '198.51.100.7')
  })

  it('has no client when every entry is a trusted proxy or an entry is not an address', () => {
    assert.equal(clientAddress(xff('192.0.2.20, 192.0.2.10'), { trustedProxyList: list }), undefined)
    assert.equal(clientAddress(xff('198.51.100.1, not-an-address, 192.0.2.10'), { trustedProxyList: list }), undefined)
    assert.equal(resetCheckClientKey(xff('192.0.2.10'), { trustedProxyList: list }), 'unknown')
  })

  it('reads the list from HITLY_TRUSTED_PROXIES, and keeps the count behaviour when it is unset', () => {
    const env = process.env as Record<string, string | undefined>
    const saved = { list: env[TRUSTED_PROXIES_ENV], count: env.HITLY_TRUSTED_PROXY_COUNT }
    try {
      env.HITLY_TRUSTED_PROXY_COUNT = '1'
      env[TRUSTED_PROXIES_ENV] = '192.0.2.0/24'
      assert.equal(clientAddress(xff('198.51.100.1, 192.0.2.20, 192.0.2.10')), '198.51.100.1')
      delete env[TRUSTED_PROXIES_ENV]
      assert.equal(clientAddress(xff('198.51.100.1, 192.0.2.20, 192.0.2.10')), '192.0.2.10')
      env.HITLY_TRUSTED_PROXY_COUNT = '2'
      assert.equal(clientAddress(xff('198.51.100.1, 192.0.2.20, 192.0.2.10')), '192.0.2.20')
    } finally {
      if (saved.list === undefined) delete env[TRUSTED_PROXIES_ENV]
      else env[TRUSTED_PROXIES_ENV] = saved.list
      if (saved.count === undefined) delete env.HITLY_TRUSTED_PROXY_COUNT
      else env.HITLY_TRUSTED_PROXY_COUNT = saved.count
    }
  })

  it('limits a client that rotates its spoofed leading entries behind two proxies', () => {
    const limit = 5
    const allow = createRateLimiter({ limit, windowMs: 60_000 })
    const results: boolean[] = []
    for (let i = 0; i <= limit; i += 1) {
      const headers = xff(`203.0.113.${i + 1}, 198.51.100.1, 192.0.2.20, 192.0.2.10`)
      results.push(allow(resetCheckClientKey(headers, { trustedProxyList: list })))
    }
    assert.deepEqual(results, [...Array(limit).fill(true), false])
  })
})
