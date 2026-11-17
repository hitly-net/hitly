import { NextResponse } from 'next/server'
import { isSignupEnabled } from '@/lib/signup'
import { applyRestLimit, clientAddressRestSubject } from '@/lib/rest-limit'

export async function GET(request: Request) {
  const limited = await applyRestLimit('read', clientAddressRestSubject(request.headers))
  if (limited) return limited
  return NextResponse.json({ signupEnabled: isSignupEnabled() })
}
