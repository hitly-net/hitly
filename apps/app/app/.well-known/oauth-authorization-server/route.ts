import { handleAuthorizationServerMetadata } from '@hitly/cloud/mcp-oauth/routes'

export function GET() {
  return handleAuthorizationServerMetadata()
}
