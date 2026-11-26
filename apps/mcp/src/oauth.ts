/**
 * Delegated (OAuth 2.1) access tokens for the MCP endpoint.
 *
 * The MCP server accepts two bearer shapes:
 * - project API keys (`hitly_…`), validated by shape here and by the host on use;
 * - opaque access tokens minted by the HITLy Cloud OAuth authorization server
 *   (per-operator login for marketplace connectors such as Grok). Those are
 *   verified against the host (`POST /api/v1/mcp/verify-token`), which checks
 *   the token's signature, expiry, audience and revocation. The MCP server
 *   never stores or interprets tokens itself; once verified, the presented
 *   token is forwarded to the host as the bearer credential on the request's
 *   behalf — no recoverable secret ever moves through the MCP server.
 *
 * When tokens are on offer, unauthenticated calls get a `WWW-Authenticate`
 * challenge pointing at the RFC 9728 Protected Resource Metadata document
 * served at /.well-known/oauth-protected-resource, which advertises the
 * authorization server. That is how spec-compliant MCP clients (Grok, Cursor)
 * discover the OAuth flow.
 */

import type { McpConfig } from './config.ts'
import type { FetchLike } from './host-client.ts'

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'

/** The scope the HITLy MCP endpoint asks for. */
export const MCP_SCOPE = 'hitly.mcp'

/** Opaque access tokens: URL-safe base64/JWT alphabet, never a resume token. */
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{20,512}$/

export type Bearer =
  | { kind: 'apikey'; key: string }
  | { kind: 'token'; token: string }
  | { error: 'missing' | 'invalid' }

/**
 * Classify the Authorization header. Same rules as extractApiKey for project
 * keys; anything else that is shaped like an opaque token is delegated and
 * must be verified with the host before use.
 */
export function extractBearer(header: string | undefined): Bearer {
  if (!header) return { error: 'missing' }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  if (!match) return { error: 'invalid' }
  const credential = match[1]
  if (credential.startsWith('hitly_resume_')) return { error: 'invalid' }
  if (/^hitly_[A-Za-z0-9_-]{16,128}$/.test(credential)) return { kind: 'apikey', key: credential }
  if (credential.startsWith('hitly_')) return { error: 'invalid' } // a malformed key stays 'invalid', not a token
  if (TOKEN_PATTERN.test(credential)) return { kind: 'token', token: credential }
  return { error: 'invalid' }
}

export type TokenVerification = { ok: true } | { ok: false; status: number }

/**
 * Ask the host to verify a delegated access token. A 200 means the token's
 * signature, expiry, audience and revocation state are all good; any other
 * answer is a refusal. Network trouble is a 502 (fail closed), never an
 * acceptance. The token itself — not a swapped-in key — is what the MCP
 * server forwards to the host for the actual call, so the host re-checks it
 * per request and no secret has to exist outside the token.
 */
export async function verifyDelegatedToken(
  config: McpConfig,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenVerification> {
  let response: Response
  try {
    response = await fetchImpl(`${config.apiUrl}/api/v1/mcp/verify-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return { ok: false, status: 502 }
  }
  if (!response.ok) return { ok: false, status: response.status }
  return { ok: true }
}

/**
 * RFC 9728 Protected Resource Metadata for this MCP server, or undefined when
 * no public URL is configured (nothing sensible can be advertised then).
 */
export function protectedResourceMetadata(config: McpConfig) {
  if (!config.publicUrl) return undefined
  return {
    resource: config.publicUrl,
    authorization_servers: [config.oauthIssuerUrl ?? config.apiUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: [MCP_SCOPE],
  }
}
