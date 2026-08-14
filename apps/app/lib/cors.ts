import { NextResponse } from 'next/server'

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|10\.0\.2\.2)$/i
const PRIVATE_LAN =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})$/

export function isTrustedAppOrigin(origin: string | null) {
  if (!origin || origin === 'null') return false
  if (origin.startsWith('hitly:') || origin.startsWith('exp:')) return true
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (LOOPBACK.test(url.hostname) || PRIVATE_LAN.test(url.hostname)) return true
    const extra = process.env.HITLY_EXPO_ORIGIN?.replace(/\/+$/, '')
    if (extra && url.origin === extra) return true
    const appUrl = (process.env.BETTER_AUTH_URL ?? 'http://localhost:3001').replace(/\/+$/, '')
    if (url.origin === appUrl) return true
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
  const appUrl = (process.env.BETTER_AUTH_URL ?? 'http://localhost:3001').replace(/\/+$/, '')
  const candidate =
    [hinted, fromUrl, appUrl].find((value) => isTrustedAppOrigin(value ?? null)) ?? appUrl

  const headers = new Headers(request.headers)
  headers.set('origin', candidate)
  return new Request(request, { headers })
}

export function corsPreflight(request: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get('origin')) })
}
