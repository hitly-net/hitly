import { NextResponse } from 'next/server'
import { isSignupEnabled } from '@/lib/signup'

export async function GET() {
  return NextResponse.json({ signupEnabled: isSignupEnabled() })
}
