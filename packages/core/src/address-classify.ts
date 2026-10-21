/**
 * Address classification shared by the destination check and origin trust.
 *
 * Pure TypeScript with no Node imports, so it runs in any runtime.
 * classifyAddress() sorts an IP literal into one of three classes:
 *   - "multicast": multicast or limited broadcast, also when carried inside an
 *     IPv6 address that embeds IPv4,
 *   - "private": loopback, unspecified, private, shared, link-local,
 *     site-local, unique-local, reserved or otherwise non-public,
 *   - "public": everything else.
 * Callers decide what each class means for them.
 */

export type AddressClass = 'public' | 'private' | 'multicast'

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

/** Classifies four IPv4 octets. */
export function classifyIPv4([a, b, c, d]: number[]): AddressClass {
  if (a >= 224 && a <= 239) return 'multicast' // 224.0.0.0/4
  if (a === 255 && b === 255 && c === 255 && d === 255) return 'multicast' // limited broadcast
  if (a === 0) return 'private' // 0.0.0.0/8 ("this network", includes 0.0.0.0)
  if (a === 127) return 'private' // loopback 127/8
  if (a === 10) return 'private' // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return 'private' // RFC1918
  if (a === 192 && b === 168) return 'private' // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return 'private' // shared address space 100.64/10
  if (a === 169 && b === 254) return 'private' // link-local 169.254/16
  if (a === 198 && (b === 18 || b === 19)) return 'private' // benchmarking 198.18/15
  if (a === 192 && b === 0 && c === 0) return 'private' // IETF protocol assignments 192.0.0/24
  if (a >= 240) return 'private' // reserved 240/4
  return 'public'
}

/** IPv4 address held in two 16-bit groups. */
function embeddedIPv4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]
}

/** Non-public unless the embedded IPv4 address is multicast or broadcast. */
function privateUnlessMulticast(hi: number, lo: number): AddressClass {
  return classifyIPv4(embeddedIPv4(hi, lo)) === 'multicast' ? 'multicast' : 'private'
}

/** Classifies eight IPv6 groups. */
export function classifyIPv6(groups: number[]): AddressClass {
  if ((groups[0] & 0xff00) === 0xff00) return 'multicast' // ff00::/8
  const allZeroUntil = (n: number) => groups.slice(0, n).every((g) => g === 0)
  if (allZeroUntil(6)) return privateUnlessMulticast(groups[6], groups[7]) // ::/96 IPv4-compatible, includes :: and ::1
  if (allZeroUntil(5) && groups[5] === 0xffff) return privateUnlessMulticast(groups[6], groups[7]) // ::ffff:0:0/96 IPv4-mapped
  if (allZeroUntil(4) && groups[4] === 0xffff && groups[5] === 0) return privateUnlessMulticast(groups[6], groups[7]) // ::ffff:0:0:0/96 IPv4-translated
  if (groups[0] === 0x2002) return classifyIPv4(embeddedIPv4(groups[1], groups[2])) // 6to4 2002::/16
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    // NAT64 64:ff9b::/96 carries the IPv4 address in the last 32 bits.
    if (groups.slice(2, 6).every((g) => g === 0)) return classifyIPv4(embeddedIPv4(groups[6], groups[7]))
    // Local-use NAT64 64:ff9b:1::/48: the embedded layout is operator-defined, so the whole range counts as private.
    if (groups[2] === 1) return 'private'
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return 'private' // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return 'private' // fe80::/10 link-local
  if ((groups[0] & 0xffc0) === 0xfec0) return 'private' // fec0::/10 site-local (deprecated)
  return 'public'
}

/** Classifies an IP literal (IPv6 brackets allowed), or returns null when it is not one. */
export function classifyAddress(address: string): AddressClass | null {
  let host = address.trim()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const v4 = parseIPv4(host)
  if (v4) return classifyIPv4(v4)
  const v6 = parseIPv6(host)
  if (v6) return classifyIPv6(v6)
  return null
}
