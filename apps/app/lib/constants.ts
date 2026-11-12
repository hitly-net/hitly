export const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000'

export const PUBLIC_PATHS = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/verify-email-change',
  '/invite',
]

/**
 * Static brand asset paths that must never redirect to /login: branded
 * emails reference /icon.svg (the mail template's logo) on this origin from
 * outside a session. Exact paths only — deliberately not a wildcard, so no
 * other route opens up. lib/brand-assets.test.ts pins this list exactly.
 *
 * All three SVGs live under public/ (NOT app/), so Next serves each at its
 * exact path as a static file with content-type image/svg+xml in dev and
 * production alike. They deliberately do NOT sit in app/: a file there is
 * only served when it matches a Next metadata icon convention, and
 * icon-open.svg matches none, so it 404'd there (which silently broke the
 * favicon swap in components/favicon-updater.tsx). Keeping every brand SVG
 * under public/ serves all of them through one mechanism. /favicon.ico is
 * NOT listed: no favicon.ico exists anywhere and nothing serves that path.
 * lib/brand-assets.test.ts pins the exact list, pins every favicon-updater
 * target to exist under public/, and pins app/ to stay free of icon files.
 */
export const BRAND_ASSET_PATHS = [
  '/icon.svg',
  '/icon-open.svg',
  '/apple-icon.svg',
] as const

/** True for an exact brand-asset pathname (query strings already stripped). */
export function isBrandAssetPath(pathname: string): boolean {
  return (BRAND_ASSET_PATHS as readonly string[]).includes(pathname)
}
