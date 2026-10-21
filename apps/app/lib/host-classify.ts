/**
 * Hostname classification for origin trust decisions.
 *
 * Works on a URL hostname (as produced by the WHATWG URL parser, which already
 * normalises IPv4 shorthand such as decimal or hex forms). IPv6 brackets are
 * stripped before parsing. Pure TypeScript, so it runs in any runtime.
 */

/** Parses a dotted-quad IPv4 address into four octets, or null. */
export function parseIPv4(value: string): number[] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    octets.push(n)
  }
  return octets
}

/** Parses an IPv6 address (optionally with an embedded IPv4 tail) into eight 16-bit groups, or null. */
export function parseIPv6(value: string): number[] | null {
  let input = value.toLowerCase()
  const zone = input.indexOf('%')
  if (zone !== -1) input = input.slice(0, zone)
  if (!input.includes(':')) return null

  // Embedded IPv4 tail, e.g. ::ffff:192.0.2.1 -> ::ffff:c000:201
  const lastColon = input.lastIndexOf(':')
  const maybeV4 = input.slice(lastColon + 1)
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4)
    if (!v4) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    input = `${input.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const halves = input.split('::')
  if (halves.length > 2) return null
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return []
    const groups: number[] = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      groups.push(parseInt(group, 16))
    }
    return groups
  }
  const head = parseGroups(halves[0])
  if (!head) return null
  const wanted = 8
  if (halves.length === 1) {
    if (head.length !== wanted) return null
    return head
  }
  const rest = parseGroups(halves[1])
  if (!rest) return null
  const fill = wanted - head.length - rest.length
  if (fill < 1) return null
  return [...head, ...new Array<number>(fill).fill(0), ...rest]
}

function isNonPublicIPv4([a, b, c]: number[]): boolean {
  if (a === 0) return true // 0.0.0.0/8 ("this network", includes 0.0.0.0)
  if (a === 127) return true // loopback 127/8
  if (a === 10) return true // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true // shared address space 100.64/10
  if (a === 169 && b === 254) return true // link-local 169.254/16
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18/15
  if (a === 192 && b === 0 && c === 0) return true // IETF protocol assignments 192.0.0/24
  if (a >= 240) return true // reserved 240/4, includes broadcast 255.255.255.255
  return false
}

/** IPv4 address held in two 16-bit groups. */
function embeddedIPv4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]
}

function isNonPublicIPv6(groups: number[]): boolean {
  const allZeroUntil = (n: number) => groups.slice(0, n).every((g) => g === 0)
  if (allZeroUntil(6)) return true // ::/96 IPv4-compatible, includes :: and ::1
  if (allZeroUntil(5) && groups[5] === 0xffff) return true // ::ffff:0:0/96 IPv4-mapped
  if (allZeroUntil(4) && groups[4] === 0xffff && groups[5] === 0) return true // ::ffff:0:0:0/96 IPv4-translated
  if (groups[0] === 0x2002) return isNonPublicIPv4(embeddedIPv4(groups[1], groups[2])) // 6to4 2002::/16
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    // NAT64 64:ff9b::/96 carries the IPv4 address in the last 32 bits.
    if (groups.slice(2, 6).every((g) => g === 0)) return isNonPublicIPv4(embeddedIPv4(groups[6], groups[7]))
    // Local-use NAT64 64:ff9b:1::/48: the embedded layout is operator-defined, so the whole range counts as private.
    if (groups[2] === 1) return true
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((groups[0] & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  return false
}

/** True for localhost, any *.localhost name, with or without a trailing dot. */
function isLocalhostName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.+$/, '')
  return name === 'localhost' || name.endsWith('.localhost')
}

/**
 * True when a URL hostname refers to a loopback, unspecified, private,
 * shared, link-local, site-local, unique-local or reserved address, an IPv6
 * address that carries a non-public IPv4 address, or a localhost name. Such hosts are never trusted as credentialed origins in production.
 */
export function isPrivateHost(hostname: string): boolean {
  if (!hostname) return true
  let host = hostname.trim()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (isLocalhostName(host)) return true
  const v4 = parseIPv4(host.replace(/\.$/, ''))
  if (v4) return isNonPublicIPv4(v4)
  const v6 = parseIPv6(host)
  if (v6) return isNonPublicIPv6(v6)
  return false
}
