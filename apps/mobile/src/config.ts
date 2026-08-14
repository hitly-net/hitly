export const CLOUD_BASE_URL = 'https://app.hitly.net'

export const SCHEME = 'hitly'

export function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export function sameOrigin(a: string, b: string) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return normalizeBaseUrl(a) === normalizeBaseUrl(b)
  }
}
