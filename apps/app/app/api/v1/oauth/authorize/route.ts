import { handleAuthorize, submitConsent, type AuthorizeContext } from '@hitly/cloud/mcp-oauth/routes'
import { requireApiSession } from '@/lib/api-session'
import { buildAuthorizeContext } from '@/lib/mcp-authorize-context'

/**
 * MCP OAuth authorization endpoint. The browser arrives here from the
 * marketplace agent (Grok etc.); a signed-in operator sees the consent screen
 * listing the projects they administer. An unauthenticated visitor is sent to
 * /login with the full authorize URL preserved in `next`.
 *
 * The token and verify endpoints are machine-facing and stay sessionless, so
 * only this endpoint consumes the session-authed budget.
 */
async function contextOrNull(): Promise<AuthorizeContext | null> {
  const authResult = await requireApiSession()
  if (!authResult.ok) return null
  return buildAuthorizeContext(authResult.session.user.id)
}

export async function GET(request: Request) {
  return handleAuthorize(request, await contextOrNull())
}

export async function POST(request: Request) {
  return submitConsent(request, await contextOrNull())
}
