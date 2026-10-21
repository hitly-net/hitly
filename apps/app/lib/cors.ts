import { NextResponse } from 'next/server'
import { isPrivateHost } from './host-classify'

const DEFAULT_APP_URL = 'http://localhost:3001'

/**
 * Explicit browser origins allowed to call the API, configured per deployment
 * via HITLY_CORS_ALLOWED_ORIGINS (comma-separated absolute origins). In
 * production this is the only source of trust beyond the app's own origin.
 */
function configuredAllowedOrigins(): string[] {
  return (process.env.HITLY_CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

/** The app's own origin, derived from BETTER_AUTH_URL (path and trailing slash ignored). */
export function appOwnOrigin(): string | null {
  const configured = (process.env.BETTER_AUTH_URL ?? '').trim() || DEFAULT_APP_URL
  try {
    return new URL(configured).origin
  } catch {
    return null
  }
}

export function isTrustedAppOrigin(origin: string | null) {
  if (!origin || origin === 'null') return false
  if (origin.startsWith('hitly:') || origin.startsWith('exp:')) return true
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (process.env.NODE_ENV === 'production') {
      // Production: never trust a loopback, private, shared, link-local,
      // unique-local, IPv4-mapped or localhost origin with credentials, even
      // when configured. Only explicitly configured origins are trusted.
      if (isPrivateHost(url.hostname)) return false
      if (configuredAllowedOrigins().includes(url.origin)) return true
      if (url.origin === appOwnOrigin()) return true
      const extra = process.env.HITLY_EXPO_ORIGIN?.replace(/\/+$/, '')
      if (extra && url.origin === extra) return true
      return false
    }
    if (isPrivateHost(url.hostname)) return true
    if (configuredAllowedOrigins().includes(url.origin)) return true
    if (url.origin === appOwnOrigin()) return true
    const extra = process.env.HITLY_EXPO_ORIGIN?.replace(/\/+$/, '')
    if (extra && url.origin === extra) return true
    return false
  } catch {
    return false
  }
}

export function allowedCorsOrigin(origin: string | null) {
  if (!origin) return null
  if (isTrustedAppOrigin(origin)) return origin
  return null
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = allowedCorsOrigin(origin)
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Hitly-Workspace-Id, X-Hitly-Origin',
    Vary: 'Origin',
  }
  if (allowed) {
    headers['Access-Control-Allow-Origin'] = allowed
    headers['Access-Control-Allow-Credentials'] = 'true'
  } else if (!origin) {
    headers['Access-Control-Allow-Origin'] = '*'
  }
  return headers
}

export function applyCors(response: NextResponse, origin: string | null) {
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    response.headers.set(key, value)
  }
  return response
}

export function withNativeAuthOrigin(request: Request) {
  const existing = request.headers.get('origin')
  if (existing && existing !== 'null') return request

  const hinted = request.headers.get('x-hitly-origin')
  const fromUrl = new URL(request.url).origin
  const appUrl = appOwnOrigin() ?? DEFAULT_APP_URL
  const candidate =
    [hinted, fromUrl, appUrl].find((value) => isTrustedAppOrigin(value ?? null)) ?? appUrl

  const headers = new Headers(request.headers)
  headers.set('origin', candidate)
  return new Request(request, { headers })
}

export function corsPreflight(request: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get('origin')) })
}
