import { handleTokenEndpoint } from '@hitly/cloud/mcp-oauth/routes'

export async function POST(request: Request) {
  return handleTokenEndpoint(request)
}
