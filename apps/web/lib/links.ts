const SITE_HOSTS = new Set(['hitly.net', 'www.hitly.net', 'localhost', '127.0.0.1'])

export function isExternalHref(href: string | undefined): boolean {
  if (!href) return false
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) return false
  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return !SITE_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

export function externalLinkProps(href: string | undefined): { target: '_blank'; rel: 'noopener noreferrer' } | Record<string, never> {
  if (!isExternalHref(href)) return {}
  return { target: '_blank', rel: 'noopener noreferrer' }
}
