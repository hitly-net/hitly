/**
 * Origin/Host validation for the /mcp endpoint (MCP spec MUST, DNS-rebinding defence).
 *
 * - A request with no Origin header (server-to-server clients, curl) is allowed.
 * - A present Origin must be loopback while the server is bound to loopback, or be on
 *   the operator allowlist (HITLY_MCP_ALLOWED_ORIGINS), or be the server's own public
 *   origin (HITLY_MCP_PUBLIC_URL). Anything else (e.g. https://evil.example) is 403.
 * - While bound to loopback the Host header must also be loopback, otherwise a
 *   rebinding DNS record could point a victim's browser at 127.0.0.1.
 */

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '')
}

export function isLoopbackHostname(hostname: string | undefined): boolean {
  if (!hostname) return false
  const h = stripBrackets(hostname.toLowerCase())
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** True when the configured listen address is loopback-only. */
export function isLoopbackBind(listenHost: string): boolean {
  const h = listenHost.trim()
  if (!h || h === '0.0.0.0' || h === '::') return false
  return isLoopbackHostname(h)
}

function hostnameOf(authority: string): string | null {
  try {
    return new URL(`http://${authority}`).hostname
  } catch {
    return null
  }
}

/** Host header check while bound to loopback: only loopback authorities pass. */
export function hostHeaderAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const hostname = hostnameOf(hostHeader)
  return hostname !== null && isLoopbackHostname(hostname)
}

/** Normalise an allowed-origin entry to its origin, or null if it is not one. */
export function normaliseOrigin(value: string): string | null {
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    if (url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

export interface OriginPolicy {
  /** Exact origins from HITLY_MCP_ALLOWED_ORIGINS. */
  allowedOrigins: ReadonlySet<string>
  /** Origin of HITLY_MCP_PUBLIC_URL, when set. */
  publicUrlOrigin?: string
  /** Server is bound to loopback: loopback origins pass. */
  loopbackBound: boolean
}

/**
 * Decide an Origin header value on /mcp. Empty/undefined Origin is allowed here
 * (server-to-server); callers pass the raw header value and 'null' (sandboxed iframes)
 * is treated as a foreign origin.
 */
export function originAllowed(origin: string | undefined, policy: OriginPolicy): boolean {
  if (origin === undefined || origin === '') return true
  if (origin === 'null') return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.pathname !== '/' || url.search || url.hash) return false
  if (policy.loopbackBound && isLoopbackHostname(url.hostname)) return true
  if (policy.allowedOrigins.has(url.origin)) return true
  if (policy.publicUrlOrigin && url.origin === policy.publicUrlOrigin) return true
  return false
}
