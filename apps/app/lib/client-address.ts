/**
 * Picks the client address for per-client limits from X-Forwarded-For.
 *
 * Each proxy appends the address it received the request from, so only the
 * right-hand entries are trustworthy: with N trusted proxies in front of the
 * app, the client is the Nth entry from the right. Anything further left was
 * sent by the client and is ignored.
 *
 * With no trusted proxies (N = 0), or no X-Forwarded-For header, the socket
 * address is used. Next.js does not expose the socket address to pages, but it
 * fills X-Forwarded-For from the socket when a request arrives without one, so
 * the default of one trusted proxy also covers a server with nothing in front.
 *
 * The trusted proxy count comes from HITLY_TRUSTED_PROXY_COUNT (default 1).
 */

export const TRUSTED_PROXY_COUNT_ENV = 'HITLY_TRUSTED_PROXY_COUNT'
export const DEFAULT_TRUSTED_PROXY_COUNT = 1

type HeaderReader = { get(name: string): string | null }

/** Reads the trusted proxy count; anything other than a whole number ≥ 0 gives the default. */
export function trustedProxyCount(env: Record<string, string | undefined> = process.env): number {
  const raw = env[TRUSTED_PROXY_COUNT_ENV]?.trim()
  if (!raw || !/^\d{1,3}$/.test(raw)) return DEFAULT_TRUSTED_PROXY_COUNT
  return Number(raw)
}

/** The client address, or undefined when there is none to use. */
export function clientAddress(
  headers: HeaderReader,
  {
    trustedProxies = trustedProxyCount(),
    remoteAddress,
  }: { trustedProxies?: number; remoteAddress?: string | null } = {},
): string | undefined {
  const socket = remoteAddress?.trim() || undefined
  if (trustedProxies <= 0) return socket
  const entries = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.length === 0) return socket
  // Fewer entries than trusted proxies: every entry was still added by a
  // trusted proxy, so the left-most one is the nearest to the client.
  return entries[Math.max(0, entries.length - trustedProxies)]
}
