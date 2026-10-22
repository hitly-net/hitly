import { isIP } from 'node:net'
import { trustedProxiesFromEnv, type TrustedProxyList } from './trusted-proxies'

/**
 * Picks the client address for per-client limits from X-Forwarded-For.
 *
 * Each proxy appends the address it received the request from, so only the
 * right-hand entries are trustworthy.
 *
 * With HITLY_TRUSTED_PROXIES set (see lib/trusted-proxies.ts), the entries are
 * walked from the right, skipping trusted proxies, and the first address that
 * is not a trusted proxy is the client. This matches Better Auth's
 * `advanced.ipAddress.trustedProxies` handling, so both limiters agree.
 *
 * Without it, HITLY_TRUSTED_PROXY_COUNT (default 1) says how many proxies are
 * in front of the app, and the client is the entry that many places from the
 * right. With a count of 0, or no X-Forwarded-For header, the socket address
 * is used. Next.js does not expose the socket address to pages, but it fills
 * X-Forwarded-For from the socket when a request arrives without one, so the
 * default of one trusted proxy also covers a server with nothing in front.
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

function forwardedEntries(headers: HeaderReader): string[] {
  return (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function addressFromList(entries: string[], list: TrustedProxyList, socket: string | undefined): string | undefined {
  // A peer that isn't a trusted proxy can write anything into the header.
  if (socket && !list.contains(socket)) return socket
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!
    if (list.contains(entry)) continue
    // Not an address: nothing further left can be trusted either.
    return isIP(entry) ? entry : undefined
  }
  // Every entry is a trusted proxy (for example a proxy's own health check).
  return entries.length === 0 ? socket : undefined
}

/** The client address, or undefined when there is none to use. */
export function clientAddress(
  headers: HeaderReader,
  {
    trustedProxies,
    trustedProxyList,
    remoteAddress,
  }: { trustedProxies?: number; trustedProxyList?: TrustedProxyList | null; remoteAddress?: string | null } = {},
): string | undefined {
  const socket = remoteAddress?.trim() || undefined
  const entries = forwardedEntries(headers)
  // An explicit count wins over the environment's list (tests and callers that pin it).
  const list = trustedProxyList !== undefined ? trustedProxyList : trustedProxies === undefined ? trustedProxiesFromEnv() : null
  if (list) return addressFromList(entries, list, socket)

  const count = trustedProxies ?? trustedProxyCount()
  if (count <= 0) return socket
  if (entries.length === 0) return socket
  // Fewer entries than trusted proxies: every entry was still added by a
  // trusted proxy, so the left-most one is the nearest to the client.
  return entries[Math.max(0, entries.length - count)]
}
