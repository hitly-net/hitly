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
 * Static brand assets served by this app (app/icon.svg, app/icon-open.svg,
 * app/apple-icon.svg and the favicon Next serves at /favicon.ico). Branded
 * emails reference them from outside a session (the mail template's logo is
 * /icon.svg on this origin), so they must never redirect to /login. Exact
 * paths only — deliberately not a wildcard, so no other route opens up.
 * lib/brand-assets.test.ts pins this list against the files on disk.
 */
export const BRAND_ASSET_PATHS = [
  '/icon.svg',
  '/icon-open.svg',
  '/apple-icon.svg',
  '/favicon.ico',
] as const

/** True for an exact brand-asset pathname (query strings already stripped). */
export function isBrandAssetPath(pathname: string): boolean {
  return (BRAND_ASSET_PATHS as readonly string[]).includes(pathname)
}
