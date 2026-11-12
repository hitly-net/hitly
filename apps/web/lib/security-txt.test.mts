import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

await import('./test/preload.mjs')

const { buildSecurityTxt, SECURITY_TXT_EXPIRES } = await import('@/lib/security-txt.ts')
const { GET } = await import('@/app/.well-known/security.txt/route.ts')

/**
 * RFC 9116 discovery file served by the marketing site: the route is a
 * public (auth-free) text/plain handler, the body carries the required
 * fields built from the SECURITY.md contacts, and the cloud-host
 * middleware never hides /.well-known/* behind the /cloud rewrite.
 */

test('security.txt carries the RFC 9116 required fields', () => {
  const body = buildSecurityTxt()
  const lines = body.split('\r\n')
  assert.ok(
    lines.some((l) => /^Contact: https:\/\/github\.com\/hitly-net\/hitly\/security\/advisories\/new$/.test(l)),
    'Contact points at the private GitHub advisory intake from SECURITY.md',
  )
  assert.ok(lines.some((l) => /^Expires: /.test(l)), 'Expires present')
  assert.ok(lines.some((l) => /^Policy: https:\/\/github\.com\/hitly-net\/hitly\/blob\/main\/SECURITY\.md$/.test(l)), 'Policy links SECURITY.md')
  assert.ok(lines.includes('Preferred-Languages: en'), 'Preferred-Languages')
  assert.ok(lines.some((l) => /^Canonical: https:\/\/hitly\.net\/\.well-known\/security\.txt$/.test(l)), 'Canonical is the site URL')
})

test('Expires is a parseable future date within the RFC refresh horizon', () => {
  const at = new Date(SECURITY_TXT_EXPIRES)
  assert.ok(!Number.isNaN(at.getTime()), 'Expires parses as an HTTP-date/ISO instant')
  const now = Date.now()
  assert.ok(at.getTime() > now, 'Expires is in the future')
  const oneYearMs = 366 * 24 * 60 * 60 * 1000
  assert.ok(at.getTime() - now < oneYearMs * 1.5, 'Expires is not set absurdly far out (RFC 9116 guidance)')
  assert.ok(buildSecurityTxt().includes(SECURITY_TXT_EXPIRES))
})

test('route GET serves the file as public text/plain', async () => {
  const response = GET()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.match(response.headers.get('cache-control') ?? '', /public/)
  const body = await response.text()
  assert.equal(body, buildSecurityTxt())
  // Public: no cookie/auth headers set, nothing session-shaped.
  assert.equal(response.headers.get('set-cookie'), null)
})

test('middleware lets /.well-known/ through on the cloud host (no /cloud rewrite)', () => {
  // next/server is not importable from a plain node test, so pin the
  // middleware's decision the same way cloud-page.test.mts pins page
  // source: the allow branch must exist and come before the /cloud rewrite.
  const src = readFileSync(fileURLToPath(new URL('../middleware.ts', import.meta.url)), 'utf8')
  const allow = src.indexOf("pathname.startsWith('/.well-known/')")
  const rewrite = src.indexOf("url.pathname = '/cloud'")
  assert.ok(allow > -1, 'middleware must carry a /.well-known/ allow branch')
  assert.ok(rewrite > -1, 'middleware keeps the cloud rewrite')
  assert.ok(allow < rewrite, 'the allow branch runs before the rewrite')
  assert.ok(/return NextResponse\.next\(\)/.test(src.slice(allow, allow + 200)), 'the allow branch passes through')
})

test('SECURITY.md and security.txt agree on the contact', () => {
  const securityMd = readFileSync(fileURLToPath(new URL('../../../SECURITY.md', import.meta.url)), 'utf8')
  const body = buildSecurityTxt()
  const url = /https:\/\/github\.com\/hitly-net\/hitly\/security\/advisories\/new/.exec(securityMd)?.[0]
  assert.ok(url, 'SECURITY.md carries the advisory intake URL')
  assert.ok(body.includes(url!), 'the Contact field matches SECURITY.md')
})
