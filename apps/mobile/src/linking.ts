import { CLOUD_BASE_URL, SCHEME, normalizeBaseUrl } from './config'
import type { AttentionLink } from './types'

export const linkingPrefixes = [`${SCHEME}://`, CLOUD_BASE_URL]

export function parseAttentionLink(url: string | null | undefined): AttentionLink | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    const hostParam = parsed.searchParams.get('host') ?? undefined
    const inbox = parsed.pathname.match(/\/inbox\/([^/]+)\/?$/)
    if (inbox?.[1]) {
      return {
        approvalId: decodeURIComponent(inbox[1]),
        instanceUrl: hostParam ? normalizeBaseUrl(hostParam) : `${parsed.protocol}//${parsed.host}`,
      }
    }
    if (parsed.protocol === `${SCHEME}:` && parsed.hostname === 'inbox' && parsed.pathname.length > 1) {
      return {
        approvalId: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
        instanceUrl: hostParam ? normalizeBaseUrl(hostParam) : undefined,
      }
    }
  } catch {
    return null
  }
  return null
}

export function parsePushData(data: Record<string, unknown> | undefined): AttentionLink | null {
  if (!data || data.type !== 'approval') return null
  const approvalId = typeof data.approvalId === 'string' ? data.approvalId : null
  if (!approvalId) return null
  const instanceUrl = typeof data.instanceUrl === 'string' ? normalizeBaseUrl(data.instanceUrl) : undefined
  return { approvalId, instanceUrl }
}
