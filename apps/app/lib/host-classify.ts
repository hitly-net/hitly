/**
 * Hostname classification for origin trust decisions.
 *
 * Works on a URL hostname (as produced by the WHATWG URL parser, which already
 * normalises IPv4 shorthand such as decimal or hex forms). IPv6 brackets are
 * stripped before parsing. The address ranges live in the shared classifier in
 * @hitly/core, which the destination check uses too.
 */
import { classifyIPv4, classifyIPv6, parseIPv4, parseIPv6 } from '@hitly/core/address-classify'

export { parseIPv4, parseIPv6 }

/** True for localhost, any *.localhost name, with or without a trailing dot. */
function isLocalhostName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.+$/, '')
  return name === 'localhost' || name.endsWith('.localhost')
}

/**
 * True when a URL hostname refers to a loopback, unspecified, private,
 * shared, link-local, site-local, unique-local, reserved or multicast address,
 * an IPv6 address that carries a non-public IPv4 address, or a localhost name.
 * Such hosts are never trusted as credentialed origins in production.
 */
export function isPrivateHost(hostname: string): boolean {
  if (!hostname) return true
  let host = hostname.trim()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (isLocalhostName(host)) return true
  const v4 = parseIPv4(host.replace(/\.$/, ''))
  if (v4) return classifyIPv4(v4) !== 'public'
  const v6 = parseIPv6(host)
  if (v6) return classifyIPv6(v6) !== 'public'
  return false
}
