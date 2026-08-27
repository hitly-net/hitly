import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { isCloudHost } from '@/lib/host'

export function middleware(request: NextRequest) {
  const host = request.headers.get('host')

  if (!isCloudHost(host)) {
    return NextResponse.next()
  }

  const { pathname } = request.nextUrl

  // Allow API routes through
  if (pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  // Allow Next.js static assets through
  if (pathname.startsWith('/_next/')) {
    return NextResponse.next()
  }

  // Allow static assets (favicon, etc.) through
  if (
    pathname === '/favicon.ico' ||
    pathname.startsWith('/favicon-') ||
    pathname.startsWith('/apple-touch-icon') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.ico')
  ) {
    return NextResponse.next()
  }

  // Already on /cloud, allow through
  if (pathname === '/cloud') {
    return NextResponse.next()
  }

  // Rewrite all other paths to /cloud
  const url = request.nextUrl.clone()
  url.pathname = '/cloud'
  return NextResponse.rewrite(url)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image).*)',
  ],
}
