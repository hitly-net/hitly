import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import {
  TRUSTED_PROXIES_ENV,
  parseTrustedProxies,
  trustedProxiesProblem,
  trustedProxyAuthOptions,
} from './trusted-proxies'

/**
 * HITLY_TRUSTED_PROXIES (lib/trusted-proxies.ts, wired into Better Auth in
 * lib/auth.ts). Addresses are from the documentation ranges.
 */

const APP_URL = 'http://localhost:3001'

describe('HITLY_TRUSTED_PROXIES parsing', () => {
  it('is off when unset or blank', () => {
    assert.equal(parseTrustedProxies(undefined), null)
    assert.equal(parseTrustedProxies(''), null)
    assert.equal(parseTrustedProxies('   '), null)
  })

  it('accepts IPv4 and IPv6 addresses and CIDR ranges', () => {
    const list = parseTrustedProxies(' 192.0.2.10, 198.51.100.0/24 ,2001:db8:1::/48,2001:db8::7 ')
    assert.ok(list)
    assert.deepEqual(list.entries, ['192.0.2.10', '198.51.100.0/24', '2001:db8:1::/48', '2001:db8::7'])
    assert.equal(list.contains('192.0.2.10'), true)
    assert.equal(list.contains('192.0.2.11'), false)
    assert.equal(list.contains('198.51.100.200'), true)
    assert.equal(list.contains('198.51.101.1'), false)
    assert.equal(list.contains('2001:db8:1:ffff::1'), true)
    assert.equal(list.contains('2001:db8:2::1'), false)
    assert.equal(list.contains('2001:db8::7'), true)
    assert.equal(list.contains('::ffff:192.0.2.10'), true)
    assert.equal(list.contains('not-an-address'), false)
  })

  it('refuses bad entries with a message that names the variable but no values', () => {
    const bad = [
      '192.0.2.300',
      '192.0.2.0/33',
      '2001:db8::/129',
      '192.0.2.0/-1',
      '192.0.2.0/24/1',
      'proxy.example',
      'fe80::1%eth0',
      '192.0.2.1, nonsense-entry',
      ',',
    ]
    for (const value of bad) {
      assert.throws(
        () => parseTrustedProxies(value),
        (error: Error) => {
          assert.match(error.message, new RegExp(TRUSTED_PROXIES_ENV))
          for (const part of value.split(',').map((p) => p.trim()).filter(Boolean)) {
            assert.ok(!error.message.includes(part), `message must not repeat ${JSON.stringify(part)}`)
          }
          return true
        },
        value,
      )
      const problem = trustedProxiesProblem({ [TRUSTED_PROXIES_ENV]: value })
      assert.ok(problem?.includes(TRUSTED_PROXIES_ENV))
    }
    assert.equal(trustedProxiesProblem({}), null)
    assert.equal(trustedProxiesProblem({ [TRUSTED_PROXIES_ENV]: '192.0.2.10' }), null)
  })
})

describe('Better Auth trusted proxy options', () => {
  it('adds nothing when the variable is unset, so Better Auth keeps its defaults', () => {
    assert.deepEqual(trustedProxyAuthOptions({}), {})
    assert.deepEqual(trustedProxyAuthOptions({ [TRUSTED_PROXIES_ENV]: ' ' }), {})
  })

  it('passes the list to advanced.ipAddress.trustedProxies when set', () => {
    assert.deepEqual(trustedProxyAuthOptions({ [TRUSTED_PROXIES_ENV]: '192.0.2.10, 2001:db8::/32' }), {
      advanced: { ipAddress: { trustedProxies: ['192.0.2.10', '2001:db8::/32'] } },
    })
  })

  function limitedAuth(env: Record<string, string | undefined>) {
    return betterAuth({
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      baseURL: APP_URL,
      secret: 'test-only-secret-at-least-32-characters',
      trustedOrigins: [APP_URL],
      rateLimit: { enabled: true, window: 60, max: 3 },
      logger: { disabled: true },
      ...trustedProxyAuthOptions(env),
    })
  }

  async function statuses(auth: ReturnType<typeof limitedAuth>, forwardedFor: (i: number) => string, count: number) {
    const out: number[] = []
    for (let i = 0; i < count; i += 1) {
      const response = await auth.handler(
        new Request(`${APP_URL}/api/auth/ok`, { headers: { 'x-forwarded-for': forwardedFor(i) } }),
      )
      out.push(response.status)
    }
    return out
  }

  it('Better Auth limits a client by the address in front of the trusted proxies', async () => {
    const auth = limitedAuth({ [TRUSTED_PROXIES_ENV]: '192.0.2.0/24' })
    // Each request spoofs a different leading entry; the proxy appends the real client.
    const spoofed = await statuses(auth, (i) => `203.0.113.${i + 1}, 198.51.100.1, 192.0.2.10`, 4)
    assert.deepEqual(spoofed, [200, 200, 200, 429])
    // A different real client still has its own allowance.
    assert.deepEqual(await statuses(auth, () => '198.51.100.2, 192.0.2.10', 1), [200])
  })

  it('without the list, Better Auth does not use a multi-entry header as the client', async () => {
    const auth = limitedAuth({})
    const different = await statuses(auth, (i) => `198.51.100.${i + 1}, 192.0.2.10`, 4)
    // All of these fall into one shared bucket (Better Auth's default handling).
    assert.deepEqual(different, [200, 200, 200, 429])
  })

  it('lib/auth.ts passes HITLY_TRUSTED_PROXIES to Better Auth', async () => {
    const env = process.env as Record<string, string | undefined>
    const saved = { DATABASE_URL: env.DATABASE_URL, [TRUSTED_PROXIES_ENV]: env[TRUSTED_PROXIES_ENV] }
    // A pool is created lazily and never connects in this test.
    env.DATABASE_URL = 'postgres://user:pass@db.example:1/unused'
    env[TRUSTED_PROXIES_ENV] = '192.0.2.10, 2001:db8::/32'
    try {
      const { auth } = await import('./auth')
      assert.ok(auth)
      const context = await auth.$context
      assert.deepEqual(context.options.advanced?.ipAddress?.trustedProxies, ['192.0.2.10', '2001:db8::/32'])
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete env[key]
        else env[key] = value
      }
    }
  })
})
