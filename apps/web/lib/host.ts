/**
 * Check if a host header matches cloud.hitly.net or www.cloud.hitly.net.
 * Strips port before comparison.
 */
export function isCloudHost(host: string | null): boolean {
  if (!host) return false
  const hostWithoutPort = host.split(':')[0]
  return hostWithoutPort === 'cloud.hitly.net' || hostWithoutPort === 'www.cloud.hitly.net'
}
