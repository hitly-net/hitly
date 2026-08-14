export const WAITLIST_INTEGRATIONS = ['mastra', 'langgraph', 'n8n'] as const

export type WaitlistIntegration = (typeof WAITLIST_INTEGRATIONS)[number]

export type WaitlistPayload = {
  name: string
  email: string
  integrations: WaitlistIntegration[]
  other: string
}

const TEST_WEBHOOK = 'https://flow.interweb-it.com/webhook-test/hitly-waitlist'
const LIVE_WEBHOOK = 'https://flow.interweb-it.com/webhook/hitly-waitlist'

export function waitlistWebhookUrl() {
  return process.env.WAITLIST_WEBHOOK_URL ?? (process.env.NODE_ENV === 'production' ? LIVE_WEBHOOK : TEST_WEBHOOK)
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function parseWaitlistPayload(input: unknown): { ok: true; data: WaitlistPayload } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid request.' }

  const body = input as Record<string, unknown>
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const other = typeof body.other === 'string' ? body.other.trim() : ''
  const rawIntegrations = Array.isArray(body.integrations) ? body.integrations : []
  const integrations = rawIntegrations.filter(
    (value): value is WaitlistIntegration =>
      typeof value === 'string' && (WAITLIST_INTEGRATIONS as readonly string[]).includes(value),
  )

  if (!name) return { ok: false, error: 'Name is required.' }
  if (name.length > 200) return { ok: false, error: 'Name is too long.' }
  if (!email || !EMAIL.test(email)) return { ok: false, error: 'A valid email is required.' }
  if (email.length > 320) return { ok: false, error: 'Email is too long.' }
  if (other.length > 200) return { ok: false, error: 'Other integration is too long.' }

  return { ok: true, data: { name, email, integrations, other } }
}
