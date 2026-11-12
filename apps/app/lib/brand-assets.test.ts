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
 *
 * Serving contract: every brand SVG lives under public/, where Next serves
 * it at its exact path with content-type image/svg+xml (dev and production
 * alike). lib/brand-assets.test.ts pins that the files really are there —
 * passing the proxy is NOT the same as being served (an app/ file that
 * matches no Next metadata convention 404s), and /favicon-updater's swaps
 * depend on /icon-open.svg actually resolving. The CI workflow additionally
 * GETs each path from a real `next start` after the build step.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.join(here, '../app')
const publicDir = path.join(here, '../public')

const ICON_FILE_PATTERN = /^(icon|apple-icon|favicon)(-.*)?\.(svg|png|ico)$/

function signedOut(pathname: string) {
  return proxy(new NextRequest(`http://localhost:3001${pathname}`))
}

/** Pathnames the favicon updater swaps in as the favicon href. */
function faviconUpdaterTargets(): string[] {
  const updater = fs.readFileSync(path.join(here, '../components/favicon-updater.tsx'), 'utf-8')
  return [...updater.matchAll(/'(\/[a-z0-9-]+\.svg)'/gi)].map((m) => m[1]!)
}

describe('brand assets are public', () => {
  it('passes every icon/logo asset in public/ signed-out (no redirect to /login)', () => {
    // Every brand icon file served by the app must be on the allowlist, so
    // a newly added icon cannot silently ship behind the login wall again.
    const onDisk = fs
      .readdirSync(publicDir)
      .filter((name) => ICON_FILE_PATTERN.test(name))
      .map((name) => `/${name}`)
    assert.ok(onDisk.includes('/icon.svg'), 'public/icon.svg exists (the email logo)')
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

  it('serves every allowlisted asset from public/ as real SVG (this is what makes them 200)', () => {
    // Next serves public/<name> at /<name> with content-type image/svg+xml,
    // so an existing, well-formed public/<name>.svg is the runtime 200 for a
    // signed-out GET (the proxy pin above proves the middleware lets it
    // through; the CI workflow GETs each path from a real `next start`).
    for (const asset of BRAND_ASSET_PATHS) {
      assert.match(asset, /^\/[a-z0-9-]+\.svg$/, `${asset} is a plain public-root SVG path`)
      const file = path.join(publicDir, asset.slice(1))
      assert.ok(fs.existsSync(file), `${asset} exists under public/ (otherwise it 404s)`)
      const body = fs.readFileSync(file, 'utf-8')
      assert.match(body, /<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${asset} is a valid SVG document`)
      assert.ok(body.length > 100, `${asset} is a real icon, not a stub`)
    }
  })

  it('has no icon files left in app/ (they would shadow public/ and 404)', () => {
    // A file in app/ is only served when it matches a Next metadata icon
    // convention, and it takes precedence over public/ — an unmatched name
    // like icon-open.svg there 404s while hiding the working public/ copy.
    const inApp = fs.readdirSync(appDir).filter((name) => ICON_FILE_PATTERN.test(name))
    assert.deepEqual(inApp, [], 'brand icons live under public/, not app/')
  })

  it('serves every favicon-updater target (the swap to /icon-open.svg must not 404)', () => {
    const used = faviconUpdaterTargets()
    assert.deepEqual(
      [...new Set(used)].sort(),
      ['/icon-open.svg', '/icon.svg'],
      'the updater swaps between the two icon files',
    )
    for (const iconPath of used) {
      assert.ok(isBrandAssetPath(iconPath), `${iconPath} is public`)
      const file = path.join(publicDir, iconPath.slice(1))
      assert.ok(fs.existsSync(file), `${iconPath} exists under public/ so the swap resolves`)
      assert.match(
        fs.readFileSync(file, 'utf-8'),
        /<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
        `${iconPath} is a valid SVG document`,
      )
    }
  })
})
