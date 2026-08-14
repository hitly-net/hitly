const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

export type PushTicket = {
  token: string
  delivered: boolean
  reason?: string
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
    title: `Hitly: ${args.actionName} needs a decision`,
    body: bodyParts.length > 0 ? bodyParts.join(' · ') : 'A work item is waiting for you.',
  }
}

export async function sendExpoPush(args: {
  tokens: string[]
  title: string
  body: string
  data: Record<string, string>
}) {
  const unique = [...new Set(args.tokens.filter(Boolean))]
  if (unique.length === 0) return [] as PushTicket[]

  const accessToken = process.env.EXPO_ACCESS_TOKEN
  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate',
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(
      unique.map((to) => ({
        to,
        title: args.title,
        body: args.body,
        sound: 'default',
        data: args.data,
      })),
    ),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Expo Push failed (${response.status}): ${text}`)
  }

  const payload = (await response.json()) as {
    data?: Array<{ status?: string; message?: string }>
  }
  const tickets = payload.data ?? []
  return unique.map((token, index) => {
    const ticket = tickets[index]
    const ok = ticket?.status === 'ok'
    return {
      token,
      delivered: ok,
      reason: ok ? undefined : ticket?.message ?? ticket?.status ?? 'unknown',
    }
  })
}
