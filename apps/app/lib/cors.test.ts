import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { allowedCorsOrigin, corsHeaders, isTrustedAppOrigin } from './cors'

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

function useEnv(env: Record<string, string | undefined>, fn: () => void) {
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
    useEnv({ NODE_ENV: 'test', BETTER_AUTH_URL: 'http://localhost:3001' }, () => {
      assert.equal(isTrustedAppOrigin('http://localhost:3001'), true)
      assert.equal(isTrustedAppOrigin('http://localhost:3002'), true, 'dev may keep localhost origins')
    })
  })

  it('never trusts null, garbage or unrelated public origins', () => {
    useEnv({ NODE_ENV: 'test', HITLY_CORS_ALLOWED_ORIGINS: '' }, () => {
      assert.equal(isTrustedAppOrigin(null), false)
      assert.equal(isTrustedAppOrigin('null'), false)
      assert.equal(isTrustedAppOrigin('not-a-url'), false)
      assert.equal(isTrustedAppOrigin('ftp://example.com'), false)
      assert.equal(isTrustedAppOrigin('https://evil.example'), false)
    })
  })

  it('trusts the configured allowlist and custom schemes', () => {
    useEnv({ NODE_ENV: 'test', HITLY_CORS_ALLOWED_ORIGINS: 'https://app.example.com' }, () => {
      assert.equal(isTrustedAppOrigin('https://app.example.com'), true)
      assert.equal(isTrustedAppOrigin('hitly://'), true)
    })
  })
})

describe('CORS trust in production', () => {
  it('refuses private-network and loopback origins with credentials', () => {
    useEnv(
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
    useEnv(
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
    useEnv(
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
    useEnv(
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
