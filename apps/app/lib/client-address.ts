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
 * Without it, HITLY_TRUSTED_PROXY_COUNT (default 1, at most 5) says how many
 * proxies are in front of the app, and the client is the entry that many
 * places from the right.
 *
 * With no reverse proxy in front of the app, set HITLY_TRUSTED_PROXY_COUNT=0.
 * Next.js does not give pages the socket address, and it only fills
 * X-Forwarded-For from the socket when a request arrives without that header,
 * so with nothing in front a client can pick the address it is counted under.
 * With a count of 0 there is no client address, and per-client limits fall
 * back to one shared ceiling (see lib/reset-check-limit.ts). The server warns
 * about this at start.
 */

export const TRUSTED_PROXY_COUNT_ENV = 'HITLY_TRUSTED_PROXY_COUNT'
export const DEFAULT_TRUSTED_PROXY_COUNT = 1
export const MAX_TRUSTED_PROXY_COUNT = 5

type HeaderReader = { get(name: string): string | null }

/**
 * Reads the trusted proxy count. Anything other than a whole number ≥ 0 gives
 * the default; values above MAX_TRUSTED_PROXY_COUNT are capped.
 */
export function trustedProxyCount(env: Record<string, string | undefined> = process.env): number {
  const raw = env[TRUSTED_PROXY_COUNT_ENV]?.trim()
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_TRUSTED_PROXY_COUNT
  return Math.min(Number(raw), MAX_TRUSTED_PROXY_COUNT)
}

function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase()
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, -dotted[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const groups = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail].map((g) => Number.parseInt(g, 16))
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null
}

/**
 * The key a per-client limit uses for an address. IPv4 addresses are used as
 * they are; IPv4-mapped IPv6 addresses become IPv4; other IPv6 addresses are
 * keyed on their /64, since one client usually holds a whole /64.
 */
export function addressLimitKey(address: string): string {
  const plain = address.split('%')[0]!
  if (isIP(plain) !== 6) return address
  const groups = ipv6Groups(plain)
  if (!groups) return address
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join('.')
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`
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
