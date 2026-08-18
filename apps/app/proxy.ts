import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { PUBLIC_PATHS } from './lib/constants'
import { applyCors, corsPreflight } from './lib/cors'

function pass(request: NextRequest) {
  const response = NextResponse.next()
  if (request.nextUrl.pathname.startsWith('/api/')) {
    applyCors(response, request.headers.get('origin'))
  }
  return response
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
    return corsPreflight(request)
  }
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return pass(request)
  }
  if (
    pathname === '/api/v1/health' ||
    pathname === '/api/v1/housekeeping' ||
    pathname.startsWith('/.well-known')
  ) {
    return pass(request)
  }
  if (pathname.startsWith('/api/auth') || (pathname.startsWith('/api/v1/approvals') && request.method === 'POST')) {
    return pass(request)
  }
  if (pathname.startsWith('/api/stripe/webhook')) {
    return pass(request)
  }

  const session = request.cookies.get('better-auth.session_token') || request.cookies.get('__Secure-better-auth.session_token')
  if (!session && !pathname.startsWith('/api/')) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  return pass(request)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
