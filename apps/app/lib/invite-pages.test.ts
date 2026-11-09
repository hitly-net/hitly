import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { PUBLIC_PATHS } from './constants'
import { proxy } from '../proxy'

/** Invite accept page wiring: public without a session, and no token in Referer headers. */

const here = path.dirname(fileURLToPath(import.meta.url))
const TOKEN = 'A'.repeat(43)

type HeaderRule = { source: string; has?: { type: string; key: string }[]; headers: { key: string; value: string }[] }

async function headerRules(): Promise<HeaderRule[]> {
  const configPath = '../next.config.mjs'
  const config = (await import(configPath)) as { default: { headers: () => Promise<HeaderRule[]> } }
  return config.default.headers()
}

describe('invite page is public', () => {
  it('lists /invite as a public path', () => {
    assert.ok(PUBLIC_PATHS.includes('/invite'))
  })

  it('lets a logged-out request for /invite/<token> through (no redirect to /login)', () => {
    const response = proxy(new NextRequest(`http://localhost:3001/invite/${TOKEN}`))
    assert.equal(response.headers.get('location'), null)
    assert.notEqual(response.status, 307)
  })

  it('still redirects a logged-out request for a private page', () => {
    const response = proxy(new NextRequest('http://localhost:3001/settings/team'))
    assert.match(response.headers.get('location') ?? '', /\/login/)
  })
})

describe('invite page response headers', () => {
  it('sends Referrer-Policy: no-referrer on /invite/<token>', async () => {
    const rule = (await headerRules()).find((r) => r.source === '/invite/:token*')
    assert.ok(rule, 'a header rule exists for the invite page')
    assert.deepEqual(rule.headers, [{ key: 'Referrer-Policy', value: 'no-referrer' }])
  })

  it('sends Referrer-Policy: no-referrer on /signup?invite=<token>', async () => {
    const rule = (await headerRules()).find((r) => r.source === '/signup' && r.has?.some((h) => h.type === 'query' && h.key === 'invite'))
    assert.ok(rule, 'a header rule exists for /signup?invite=')
    assert.deepEqual(rule.headers, [{ key: 'Referrer-Policy', value: 'no-referrer' }])
  })

  it('sets the no-referrer meta tag on the invite page', () => {
    const page = fs.readFileSync(path.join(here, '../app/invite/[token]/page.tsx'), 'utf-8')
    const metadata = page.match(/export const metadata = \{([^}]*)\}/)
    assert.ok(metadata)
    assert.match(metadata[1], /\breferrer:\s*'no-referrer'/)
  })
})
