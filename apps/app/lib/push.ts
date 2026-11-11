import { extractDecisionEmailContent } from '@hitly/mail'

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'
export const EXPO_PUSH_TIMEOUT_MS = 10_000

export type PushTicket = {
  token: string
  delivered: boolean
  ticketId?: string
  reason?: string
}

export type ExpoPushSendResult = {
  tickets: PushTicket[]
  staleTokens: string[]
}

type ExpoTicket = {
  status?: string
  id?: string
  message?: string
  details?: { error?: string }
}

function expiresLabel(expiresAt: Date | string | null | undefined, now: Date = new Date()) {
  if (!expiresAt) return null
  const at = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000)
  if (!Number.isFinite(minutes)) return null
  if (minutes <= 0) return 'expired'
  if (minutes < 60) return `expires in ${minutes}m`
  const hours = Math.round(minutes / 60)
  return `expires in ${hours}h`
}

export type DecisionCopyArgs = {
  projectName?: string | null
  /** Decoded approval envelope (only the allowlisted prompt is read). */
  envelope?: Record<string, unknown> | null
  /** Decoded origin bag (only human-facing display names are read). */
  origin?: Record<string, unknown> | null
  requestedByKey?: string | null
  expiresAt?: Date | string | null
  now?: Date
}

/**
 * Push copy for a pending decision. Titles reuse the branded email's wording
 * helper (extractDecisionEmailContent from @hitly/mail) so push and email
 * match: ask_user pushes the question itself; approvals push the same
 * "HITLy: <project> needs your decision" summary. The raw tool name is
 * never part of either. The body is "<project> · expires in Xh" using the
 * real expiry. Callers must pass DECODED envelope/origin (decodeTenantJson).
 */
export function pushCopy(args: DecisionCopyArgs) {
  const content = extractDecisionEmailContent(args)
  const sla = expiresLabel(args.expiresAt, args.now)
  const bodyParts = [content.projectName, sla].filter(Boolean)
  return {
    title: content.pushTitle,
    body: bodyParts.length > 0 ? bodyParts.join(' · ') : 'A work item is waiting for you.',
  }
}

export function isDeviceNotRegistered(ticket: ExpoTicket | undefined) {
  if (!ticket) return false
  if (ticket.details?.error === 'DeviceNotRegistered') return true
  return typeof ticket.message === 'string' && ticket.message.includes('DeviceNotRegistered')
}

function expoHeaders() {
  const accessToken = process.env.EXPO_ACCESS_TOKEN
  return {
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate',
    'content-type': 'application/json',
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  }
}

export async function fetchExpoPushReceipts(ticketIds: string[]): Promise<Record<string, ExpoTicket>> {
  const unique = [...new Set(ticketIds.filter(Boolean))]
  if (unique.length === 0) return {}
  const response = await fetch(EXPO_RECEIPTS_URL, {
    method: 'POST',
    headers: expoHeaders(),
    body: JSON.stringify({ ids: unique }),
    signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Expo Push receipts failed (${response.status}): ${text}`)
  }
  const payload = (await response.json()) as { data?: Record<string, ExpoTicket> }
  return payload.data ?? {}
}

export async function sendExpoPush(args: {
  tokens: string[]
  title: string
  body: string
  data: Record<string, string>
  badge?: number
}): Promise<ExpoPushSendResult> {
  const unique = [...new Set(args.tokens.filter(Boolean))]
  if (unique.length === 0) return { tickets: [], staleTokens: [] }

  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: expoHeaders(),
    body: JSON.stringify(
      unique.map((to) => ({
        to,
        title: args.title,
        body: args.body,
        sound: 'default',
        channelId: 'hitly',
        ...(typeof args.badge === 'number' ? { badge: args.badge } : {}),
        data: args.data,
      })),
    ),
    signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Expo Push failed (${response.status}): ${text}`)
  }

  const payload = (await response.json()) as { data?: ExpoTicket[] }
  const rawTickets = payload.data ?? []
  const stale = new Set<string>()
  const receiptIds: Array<{ id: string; token: string }> = []
  const tickets = unique.map((token, index) => {
    const ticket = rawTickets[index]
    if (isDeviceNotRegistered(ticket)) stale.add(token)
    if (ticket?.status === 'ok' && typeof ticket.id === 'string' && ticket.id) {
      receiptIds.push({ id: ticket.id, token })
    }
    const ok = ticket?.status === 'ok'
    return {
      token,
      delivered: ok,
      ticketId: typeof ticket?.id === 'string' ? ticket.id : undefined,
      reason: ok ? undefined : ticket?.message ?? ticket?.status ?? 'unknown',
    }
  })

  if (receiptIds.length > 0) {
    try {
      const receipts = await fetchExpoPushReceipts(receiptIds.map((row) => row.id))
      for (const row of receiptIds) {
        if (isDeviceNotRegistered(receipts[row.id])) stale.add(row.token)
      }
    } catch (error) {
      console.error('[hitly push] receipts', error instanceof Error ? error.message : error)
    }
  }

  return { tickets, staleTokens: [...stale] }
}
