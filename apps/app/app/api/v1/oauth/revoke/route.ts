import { handleRevokeEndpoint } from '@hitly/cloud/mcp-oauth/routes'

export async function POST(request: Request) {
  return handleRevokeEndpoint(request)
}
