import { NextResponse } from 'next/server'

/**
 * Open-source stub. Delegated MCP OAuth (marketplace agents such as Grok)
 * is a hosted-edition capability: it requires the cloud authorization
 * server and the token-validation seam on the host API.
 */

export type AuthorizeContext = {
  userId: string
  projects: Array<{
    workspaceId: string
    workspaceName: string
    projectId: string
    projectName: string
  }>
}

function mcpOAuthUnavailable(): Response {
  return NextResponse.json(
    { error: 'MCP OAuth is not available in the open-source edition' },
    { status: 404 },
  )
}

export function handleAuthorizationServerMetadata(): Response {
  return mcpOAuthUnavailable()
}

export async function handleAuthorize(_request: Request, _ctx: AuthorizeContext | null): Promise<Response> {
  return mcpOAuthUnavailable()
}

export async function submitConsent(_request: Request, _ctx: AuthorizeContext | null): Promise<Response> {
  return mcpOAuthUnavailable()
}

export async function handleTokenEndpoint(_request: Request): Promise<Response> {
  return mcpOAuthUnavailable()
}

export async function handleRevokeEndpoint(_request: Request): Promise<Response> {
  return mcpOAuthUnavailable()
}

export async function handleVerifyToken(_request: Request): Promise<Response> {
  return mcpOAuthUnavailable()
}

export async function handleRevokeAll(_workspaceId: string): Promise<{ revoked: number }> {
  return { revoked: 0 }
}

export async function listConnections(
  _workspaceId: string,
): Promise<Array<{ clientName: string; projectName: string; createdAt: string | null; lastUsedAt: string | null }>> {
  return []
}
