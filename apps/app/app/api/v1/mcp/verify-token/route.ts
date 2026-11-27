import { handleVerifyToken } from '@hitly/cloud/mcp-oauth/routes'
import { handleMcpVerifyTokenFactory } from '@/lib/mcp-verify-token-route'

/**
 * Pre-flight check for the HITLy MCP edge: "is this bearer one of our
 * delegated access tokens?" The token arrives ONLY in the Authorization
 * header (no body); the edge authenticates with x-hitly-mcp-secret and the
 * budget keys on the caller, never the presented token (see
 * lib/mcp-verify-token-route.ts for the full contract). The answer says
 * only acceptable/not — identity and project stay on the host side, where
 * the same token is resolved again through the edition seam.
 */
const handlePost = handleMcpVerifyTokenFactory({
  callerSecret: process.env.HITLY_MCP_VERIFY_TOKEN_SECRET,
  delegate: (request) => handleVerifyToken(request),
})

export async function POST(request: Request) {
  return handlePost(request)
}
