import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { allowedCorsOrigin, appOwnOrigin, corsHeaders, isTrustedAppOrigin, withNativeAuthOrigin } from './cors'

/**
 * CORS trust rules (lib/cors.ts).
 *
 * Development may trust loopback and private-network origins. Production
 * must not trust any private-network or loopback origin with credentials —
 * there, only origins explicitly configured via HITLY_CORS_ALLOWED_ORIGINS or
 * the app's own BETTER_AUTH_URL origin are trusted.
 */

const saved = {
  NODE_ENV: process.env.NODE_ENV,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  HITLY_CORS_ALLOWED_ORIGINS: process.env.HITLY_CORS_ALLOWED_ORIGINS,
  HITLY_EXPO_ORIGIN: process.env.HITLY_EXPO_ORIGIN,
}

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const snapshot = { ...saved, ...Object.fromEntries(Object.keys(saved).map((k) => [k, process.env[k]])) }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    void snapshot
  }
}

describe('CORS trust in development', () => {
  it('trusts loopback and the app origin', () => {
    withEnv({ NODE_ENV: 'test', BETTER_AUTH_URL: 'http://localhost:3001' }, () => {
      assert.equal(isTrustedAppOrigin('http://localhost:3001'), true)
      assert.equal(isTrustedAppOrigin('http://localhost:3002'), true, 'dev may keep localhost origins')
    })
  })

  it('never trusts null, garbage or unrelated public origins', () => {
    withEnv({ NODE_ENV: 'test', HITLY_CORS_ALLOWED_ORIGINS: '' }, () => {
      assert.equal(isTrustedAppOrigin(null), false)
      assert.equal(isTrustedAppOrigin('null'), false)
      assert.equal(isTrustedAppOrigin('not-a-url'), false)
      assert.equal(isTrustedAppOrigin('ftp://example.com'), false)
      assert.equal(isTrustedAppOrigin('https://evil.example'), false)
    })
  })

  it('trusts the configured allowlist and custom schemes', () => {
    withEnv({ NODE_ENV: 'test', HITLY_CORS_ALLOWED_ORIGINS: 'https://app.example.com' }, () => {
      assert.equal(isTrustedAppOrigin('https://app.example.com'), true)
      assert.equal(isTrustedAppOrigin('hitly://'), true)
    })
  })
})

describe('CORS trust in production', () => {
  it('refuses private-network and loopback origins with credentials', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        BETTER_AUTH_URL: 'https://app.example.com',
        HITLY_CORS_ALLOWED_ORIGINS: '',
      },
      () => {
        assert.equal(isTrustedAppOrigin('http://localhost:3001'), false)
        assert.equal(isTrustedAppOrigin('http://127.0.0.1:3001'), false)
        assert.equal(isTrustedAppOrigin('http://192.0.2.10:3001'), false)
        assert.equal(isTrustedAppOrigin('http://10.0.0.5'), false)
      },
    )
  })

  it('refuses private origins even when they appear in the allowlist', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        BETTER_AUTH_URL: 'https://app.example.com',
        HITLY_CORS_ALLOWED_ORIGINS: 'http://192.168.99.7:8080,http://10.0.0.5',
      },
      () => {
        assert.equal(isTrustedAppOrigin('http://192.168.99.7:8080'), false)
        assert.equal(isTrustedAppOrigin('http://10.0.0.5'), false)
      },
    )
  })

  it('trusts only explicitly configured public origins', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        BETTER_AUTH_URL: 'https://app.example.com',
        HITLY_CORS_ALLOWED_ORIGINS: 'https://admin.example.com,https://other.example.com',
      },
      () => {
        assert.equal(isTrustedAppOrigin('https://app.example.com'), true)
        assert.equal(isTrustedAppOrigin('https://admin.example.com'), true)
        assert.equal(isTrustedAppOrigin('https://other.example.com'), true)
        assert.equal(isTrustedAppOrigin('https://unlisted.example.com'), false)
        assert.equal(isTrustedAppOrigin('http://admin.example.com'), false, 'scheme must match')
      },
    )
  })

  it('does not echo an untrusted origin into CORS headers or grant credentials', () => {
    withEnv(
      { NODE_ENV: 'production', BETTER_AUTH_URL: 'https://app.example.com', HITLY_CORS_ALLOWED_ORIGINS: '' },
      () => {
        assert.equal(allowedCorsOrigin('http://localhost:3001'), null)
        const headers = corsHeaders('http://localhost:3001')
        assert.equal(headers['Access-Control-Allow-Origin'], undefined)
        assert.equal(headers['Access-Control-Allow-Credentials'], undefined)
      },
    )
  })
})

const NON_PUBLIC_ORIGINS = [
  // loopback, all of 127/8 and ::1
  'http://127.0.0.1:3001',
  'http://127.0.0.2',
  'http://127.255.255.254',
  'http://[::1]:3001',
  // unspecified
  'http://0.0.0.0:3001',
  'http://[::]',
  // RFC1918
  'http://10.1.2.3',
  'http://172.16.0.1',
  'http://172.31.255.255',
  'http://192.168.1.10:8080',
  // shared address space 100.64/10
  'http://100.64.0.1',
  'http://100.127.255.254',
  // link-local
  'http://169.254.169.254',
  'http://[fe80::1]',
  'http://[febf::1]',
  // unique local fc00::/7
  'http://[fc00::1]',
  'http://[fd12:3456:789a::1]',
  // IPv4-mapped IPv6
  'http://[::ffff:127.0.0.1]',
  'http://[::ffff:10.0.0.1]',
  'http://[::ffff:203.0.113.9]',
  // localhost names, with and without a trailing dot
  'http://localhost:3001',
  'http://localhost.:3001',
  'http://app.localhost',
  'http://app.localhost.:3001',
  // IPv4 shorthand that the URL parser normalises to loopback
  'http://2130706433',
  'http://0x7f.1',
]

describe('CORS trust in production: non-public hosts are refused even when allowlisted', () => {
  for (const origin of NON_PUBLIC_ORIGINS) {
    it(`refuses ${origin}`, () => {
      const normalised = new URL(origin).origin
      withEnv(
        {
          NODE_ENV: 'production',
          BETTER_AUTH_URL: normalised,
          HITLY_EXPO_ORIGIN: normalised,
          HITLY_CORS_ALLOWED_ORIGINS: `${normalised},https://app.example.com`,
        },
        () => {
          assert.equal(isTrustedAppOrigin(origin), false)
          assert.equal(isTrustedAppOrigin(normalised), false)
          const headers = corsHeaders(normalised)
          assert.equal(headers['Access-Control-Allow-Origin'], undefined)
          assert.equal(headers['Access-Control-Allow-Credentials'], undefined)
        },
      )
    })
  }

  it('still trusts a public allowlisted origin next to them', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        BETTER_AUTH_URL: 'https://app.example.com',
        HITLY_CORS_ALLOWED_ORIGINS: 'http://[::1],https://admin.example.com',
      },
      () => {
        assert.equal(isTrustedAppOrigin('https://admin.example.com'), true)
        assert.equal(isTrustedAppOrigin('http://100.63.255.255'), false, 'public but not allowlisted')
      },
    )
  })
})

describe('CORS headers', () => {
  it('always sends Vary: Origin', () => {
    withEnv({ NODE_ENV: 'production', BETTER_AUTH_URL: 'https://app.example.com', HITLY_CORS_ALLOWED_ORIGINS: '' }, () => {
      assert.equal(corsHeaders('https://app.example.com').Vary, 'Origin', 'trusted origin')
      assert.equal(corsHeaders('https://unlisted.example.com').Vary, 'Origin', 'untrusted origin')
      assert.equal(corsHeaders(null).Vary, 'Origin', 'no origin')
    })
  })

  it('never sends credentials together with a wildcard origin', () => {
    withEnv({ NODE_ENV: 'production', BETTER_AUTH_URL: 'https://app.example.com', HITLY_CORS_ALLOWED_ORIGINS: '' }, () => {
      const headers = corsHeaders(null)
      assert.equal(headers['Access-Control-Allow-Origin'], '*')
      assert.equal(headers['Access-Control-Allow-Credentials'], undefined)
    })
    for (const origin of [null, 'https://app.example.com', 'https://unlisted.example.com', 'http://localhost:3001']) {
      for (const NODE_ENV of ['production', 'test']) {
        withEnv({ NODE_ENV, BETTER_AUTH_URL: 'https://app.example.com', HITLY_CORS_ALLOWED_ORIGINS: '' }, () => {
          const headers = corsHeaders(origin)
          if (headers['Access-Control-Allow-Credentials'] === 'true') {
            assert.notEqual(headers['Access-Control-Allow-Origin'], '*', `${NODE_ENV} ${origin}`)
            assert.equal(headers['Access-Control-Allow-Origin'], origin)
          }
        })
      }
    }
  })

  it('grants credentials with the exact echoed origin for a trusted origin', () => {
    withEnv({ NODE_ENV: 'production', BETTER_AUTH_URL: 'https://app.example.com', HITLY_CORS_ALLOWED_ORIGINS: '' }, () => {
      const headers = corsHeaders('https://app.example.com')
      assert.equal(headers['Access-Control-Allow-Origin'], 'https://app.example.com')
      assert.equal(headers['Access-Control-Allow-Credentials'], 'true')
    })
  })
})

describe('app origin matching', () => {
  it('derives the app origin from BETTER_AUTH_URL with new URL().origin', () => {
    withEnv({ BETTER_AUTH_URL: 'https://app.example.com/base/path/' }, () => {
      assert.equal(appOwnOrigin(), 'https://app.example.com')
    })
    withEnv({ BETTER_AUTH_URL: 'HTTPS://App.Example.com:443' }, () => {
      assert.equal(appOwnOrigin(), 'https://app.example.com')
    })
    withEnv({ BETTER_AUTH_URL: 'not a url' }, () => {
      assert.equal(appOwnOrigin(), null)
    })
  })

  it('trusts the app origin when BETTER_AUTH_URL carries a path', () => {
    withEnv(
      { NODE_ENV: 'production', BETTER_AUTH_URL: 'https://app.example.com/base/', HITLY_CORS_ALLOWED_ORIGINS: '' },
      () => {
        assert.equal(isTrustedAppOrigin('https://app.example.com'), true)
      },
    )
  })

  it('matches origins exactly, never by prefix', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        BETTER_AUTH_URL: 'https://app.example.com',
        HITLY_CORS_ALLOWED_ORIGINS: 'https://admin.example.com',
      },
      () => {
        for (const origin of [
          'https://app.example.com.other.example',
          'https://app.example.comx',
          'https://app.example.com:8443',
          'https://admin.example.com.other.example',
          'https://admin.example.co',
          'https://xadmin.example.com',
        ]) {
          assert.equal(isTrustedAppOrigin(origin), false, origin)
        }
      },
    )
  })
})

describe('withNativeAuthOrigin', () => {
  it('fills a missing Origin from the app origin derived from BETTER_AUTH_URL', () => {
    withEnv({ NODE_ENV: 'test', BETTER_AUTH_URL: 'http://localhost:3001/some/path' }, () => {
      const request = withNativeAuthOrigin(new Request('http://localhost:3001/api/auth/get-session'))
      assert.equal(request.headers.get('origin'), 'http://localhost:3001')
    })
  })

  it('keeps an existing Origin header', () => {
    withEnv({ NODE_ENV: 'test', BETTER_AUTH_URL: 'http://localhost:3001' }, () => {
      const original = new Request('http://localhost:3001/api/auth/get-session', {
        headers: { origin: 'https://app.example.com' },
      })
      assert.equal(withNativeAuthOrigin(original), original)
    })
  })
})
