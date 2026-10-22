import { BlockList, isIP } from 'node:net'

/**
 * HITLY_TRUSTED_PROXIES: a comma-separated list of IP addresses and CIDR
 * ranges for the reverse proxies in front of the app. When it is set, the
 * client address is the right-most X-Forwarded-For entry that is not one of
 * these proxies, both for Better Auth's request limiter
 * (`advanced.ipAddress.trustedProxies`) and for the app's own per-client
 * limits (lib/client-address.ts). When it is unset, Better Auth keeps its
 * default handling and the app falls back to HITLY_TRUSTED_PROXY_COUNT.
 *
 * Error messages name the variable but never repeat its entries.
 */

export const TRUSTED_PROXIES_ENV = 'HITLY_TRUSTED_PROXIES'

export type TrustedProxyList = {
  /** The entries as configured (trimmed), in the form Better Auth accepts. */
  entries: string[]
  /** Whether an address is one of the trusted proxies. False for anything that isn't an IP. */
  contains: (address: string) => boolean
}

function addEntry(list: BlockList, entry: string): boolean {
  if (entry.includes('%')) return false // zone ids are not accepted by Better Auth
  const slash = entry.indexOf('/')
  const address = slash === -1 ? entry : entry.slice(0, slash)
  const version = isIP(address)
  if (version === 0) return false
  const type = version === 6 ? 'ipv6' : 'ipv4'
  if (slash === -1) {
    list.addAddress(address, type)
    return true
  }
  const prefix = entry.slice(slash + 1)
  if (!/^\d{1,3}$/.test(prefix)) return false
  const bits = Number(prefix)
  if (bits > (version === 6 ? 128 : 32)) return false
  list.addSubnet(address, bits, type)
  return true
}

/**
 * Parses the trusted proxy list. Returns null when the value is unset or
 * blank; throws when any entry is not an IP address or CIDR range.
 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxyList | null {
  if (raw === undefined || raw.trim() === '') return null
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const list = new BlockList()
  const invalid = entries.filter((entry) => !addEntry(list, entry)).length
  if (entries.length === 0 || invalid > 0) {
    throw new Error(
      `${TRUSTED_PROXIES_ENV} has ${invalid || 'no'} invalid ${invalid === 1 ? 'entry' : 'entries'}; ` +
        'use a comma-separated list of IP addresses or CIDR ranges',
    )
  }
  return {
    entries,
    contains: (address) => {
      const version = isIP(address)
      return version !== 0 && list.check(address, version === 6 ? 'ipv6' : 'ipv4')
    },
  }
}

/** Why the configured value is unusable, or null. Never includes the value. */
export function trustedProxiesProblem(env: Record<string, string | undefined> = process.env): string | null {
  try {
    parseTrustedProxies(env[TRUSTED_PROXIES_ENV])
    return null
  } catch (error) {
    return error instanceof Error ? error.message : `${TRUSTED_PROXIES_ENV} is invalid`
  }
}

let cached: { raw: string | undefined; list: TrustedProxyList | null } | undefined

/** The configured list (parsed once per value), or null when unset. Throws on a bad value. */
export function trustedProxiesFromEnv(env: Record<string, string | undefined> = process.env): TrustedProxyList | null {
  const raw = env[TRUSTED_PROXIES_ENV]
  if (cached && cached.raw === raw) return cached.list
  const list = parseTrustedProxies(raw)
  cached = { raw, list }
  return list
}

/**
 * Better Auth options for the trusted proxies: `advanced.ipAddress.trustedProxies`
 * when the list is set, and nothing at all when it is unset.
 */
export function trustedProxyAuthOptions(
  env: Record<string, string | undefined> = process.env,
): { advanced?: { ipAddress: { trustedProxies: string[] } } } {
  const list = trustedProxiesFromEnv(env)
  return list ? { advanced: { ipAddress: { trustedProxies: [...list.entries] } } } : {}
}
