export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'

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

function expiresLabel(expiresAt: Date | string | null | undefined) {
  if (!expiresAt) return null
  const at = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt
  const minutes = Math.round((at.getTime() - Date.now()) / 60_000)
  if (!Number.isFinite(minutes)) return null
  if (minutes <= 0) return 'expired'
  if (minutes < 60) return `expires in ${minutes}m`
  const hours = Math.round(minutes / 60)
  return `expires in ${hours}h`
}

export function pushCopy(args: {
  actionName: string
  projectName?: string | null
  expiresAt?: Date | string | null
}) {
  const sla = expiresLabel(args.expiresAt)
  const bodyParts = [args.projectName?.trim(), sla].filter(Boolean)
  return {
    title: `HITLy: ${args.actionName} needs a decision`,
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
