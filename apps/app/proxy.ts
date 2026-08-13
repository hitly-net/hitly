import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { PUBLIC_PATHS } from './lib/constants'

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next()
  }
  if (pathname.startsWith('/api/auth') || (pathname.startsWith('/api/v1/approvals') && request.method === 'POST')) {
    return NextResponse.next()
  }
  if (pathname.startsWith('/api/stripe/webhook')) {
    return NextResponse.next()
  }

  const session = request.cookies.get('better-auth.session_token')
  if (!session && !pathname.startsWith('/api/')) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
