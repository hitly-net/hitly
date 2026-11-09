import type { EvidenceClient } from '@hitly/core'

/**
 * Classify the reviewer client from request headers, for the evidence
 * `client` field (`hitly.evidence.v1` only - hitl-spec 5.3 keeps device data
 * out of the generic event envelope).
 *
 * `channel` is a self-reported session hint, not a host-verified device
 * identity: cookie sessions are `web`; `x-hitly-client` is honoured only on
 * bearer sessions (mobile apps). No IP address is recorded (privacy; device
 * data stays minimal).
 */

export const CLIENT_HEADER = 'x-hitly-client'
const ORIGIN_HEADER = 'x-hitly-origin'
const UA_LIMIT = 512

/**
 * `hitly-client: hitly-mobile/<appVersion> (<ios|android>)`
 * Malformed values are ignored (fields simply stay unset).
 */
export function parseMobileClientHeader(
  raw: string | null,
): { appVersion?: string; platform?: 'ios' | 'android' } | undefined {
  if (!raw) return undefined
  const match = /^hitly-mobile\/([^\s()]+)(?:\s*\((ios|android)\))?$/i.exec(raw.trim())
  if (!match) return undefined
  const platform = match[2] ? (match[2].toLowerCase() as 'ios' | 'android') : undefined
  return { appVersion: match[1], ...(platform ? { platform } : {}) }
}

function sanitizeUserAgent(raw: string | null): string | undefined {
  if (!raw) return undefined
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim()
  if (!cleaned) return undefined
  return cleaned.slice(0, UA_LIMIT)
}

export function clientFromHeaders(headers: Headers): EvidenceClient {
  const authorization = headers.get('authorization') ?? ''
  const hasBearer = /^Bearer\s+\S+/i.test(authorization)
  // S97-S1: `x-hitly-client` is client-asserted. Honour it only on bearer
  // sessions so a cookie (web) session cannot flip `channel` to `mobile`.
  const rawClient = hasBearer ? headers.get(CLIENT_HEADER) : null
  const hasOriginHeader = hasBearer && Boolean(headers.get(ORIGIN_HEADER))

  let channel: EvidenceClient['channel']
  if (hasBearer && (rawClient || hasOriginHeader)) {
    // The mobile app sends `x-hitly-origin` (and now `x-hitly-client`) with its
    // bearer session; a bare bearer without those headers is a raw API client.
    channel = 'mobile'
  } else if (hasBearer) {
    channel = 'api'
  } else {
    // Cookie session from the web app.
    channel = 'web'
  }

  const client: EvidenceClient = { channel }
  const parsed = parseMobileClientHeader(rawClient)
  if (parsed?.appVersion) client.appVersion = parsed.appVersion
  if (parsed?.platform) client.platform = parsed.platform
  const userAgent = sanitizeUserAgent(headers.get('user-agent'))
  if (userAgent) client.userAgent = userAgent
  return client
}
