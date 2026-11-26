import { NextResponse } from 'next/server'
import { handleVerifyToken } from '@hitly/cloud/mcp-oauth/routes'

/** Same token grammar the MCP server forwards (see apps/mcp/src/oauth.ts). */
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{20,512}$/

/**
 * Pre-flight check for the MCP server: "is this bearer one of our delegated
 * access tokens?" A malformed credential is refused locally so probing
 * garbage never reaches the verification path. The response says only
 * acceptable/not — identity and project stay on the host side, where the
 * same token is resolved again through the edition seam.
 */
export async function POST(request: Request) {
  let token: unknown
  try {
    token = (await request.json()).token
  } catch {
    token = null
  }
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 })
  }
  return handleVerifyToken(request)
}
