import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { BRAND_ASSET_PATHS, isBrandAssetPath } from './constants'
import { proxy } from '../proxy'

/**
 * Signed-out brand assets: branded emails reference /icon.svg (and the
 * other icons) from outside a session, so the auth proxy must never
 * redirect them to /login — and the allowlist must stay exact so no other
 * route opens up.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.join(here, '../app')

function signedOut(pathname: string) {
  return proxy(new NextRequest(`http://localhost:3001${pathname}`))
}

describe('brand assets are public', () => {
  it('passes every icon/logo asset in app/ signed-out (no redirect to /login)', () => {
    // Every Next metadata icon file in app/ must be on the allowlist, so a
    // newly added icon cannot silently ship behind the login wall again.
    // Note: passing the proxy is not the same as being served — only
    // /icon.svg is a Next metadata route today (see constants.ts note).
    const onDisk = fs
      .readdirSync(appDir)
      .filter((name) => /^(icon|apple-icon|favicon)(-.*)?\.(svg|png|ico)$/.test(name))
      .map((name) => `/${name}`)
    assert.ok(onDisk.includes('/icon.svg'), 'app/icon.svg exists (the email logo)')
    for (const asset of onDisk) {
      assert.ok(isBrandAssetPath(asset), `${asset} is on the brand-asset allowlist`)
    }
    // And each allowlisted path passes the proxy without a session cookie.
    for (const asset of BRAND_ASSET_PATHS) {
      const response = signedOut(asset)
      assert.equal(response.headers.get('location'), null, `${asset} must not redirect`)
      assert.ok(response.status < 300 || response.status >= 400, `${asset} must not be a redirect`)
    }
  })

  it('is exactly the brand-asset list: nothing else can join the public allowlist', () => {
    // The signed-out pass-through is limited to the brand assets — adding an
    // unrelated path (e.g. '/inbox') to BRAND_ASSET_PATHS fails this pin.
    assert.deepEqual(
      [...BRAND_ASSET_PATHS].sort(),
      ['/apple-icon.svg', '/icon-open.svg', '/icon.svg'],
      'the public list is exactly the brand asset paths',
    )
    for (const notBrand of ['/inbox', '/favicon.ico', '/manifest.webmanifest', '/logo.svg']) {
      assert.equal(isBrandAssetPath(notBrand), false, `${notBrand} is not a brand asset`)
      assert.match(signedOut(notBrand).headers.get('location') ?? '', /\/login/, `${notBrand} still redirects`)
    }
  })

  it('still redirects a signed-out request for a protected route', () => {
    const response = signedOut('/settings/security')
    assert.match(response.headers.get('location') ?? '', /\/login/)
  })

  it('is an exact-path allowlist: nothing near a brand path slips through', () => {
    for (const near of ['/icon.svg/../../settings', '/icon.svgx', '/icons.svg', '/settings/icon.svg']) {
      assert.equal(isBrandAssetPath(near), false, `${near} must not be allowlisted`)
      const response = signedOut(near)
      assert.match(response.headers.get('location') ?? '', /\/login/, `${near} still redirects`)
    }
  })

  it('matches the favicon on the public icon used by the favicon updater', () => {
    const updater = fs.readFileSync(path.join(here, '../components/favicon-updater.tsx'), 'utf-8')
    const used = [...updater.matchAll(/'(\/icon[^']*)'/g)].map((m) => m[1]!)
    assert.ok(used.length > 0, 'the updater swaps between the two icon files')
    for (const iconPath of used) {
      assert.ok(isBrandAssetPath(iconPath), `${iconPath} is public`)
    }
  })
})
