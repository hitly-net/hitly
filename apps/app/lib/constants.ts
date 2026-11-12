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
 * Note: only /icon.svg is actually served today (it is a Next metadata icon
 * file). /icon-open.svg and /apple-icon.svg sit in app/ but match no Next
 * metadata convention, so they 404. They stay allowlisted because
 * components/favicon-updater.tsx swaps /icon-open.svg in as the favicon
 * (currently 404s too) — a known pre-existing issue, deliberately not
 * touched here. /favicon.ico is NOT listed: no app/favicon.ico exists and
 * nothing serves that path.
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
