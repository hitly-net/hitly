import type { TransportName } from './types'

const TRANSPORTS = new Set<TransportName>(['console', 'smtp', 'resend', 'memory'])

export function resolveTransportName(env: NodeJS.ProcessEnv = process.env): TransportName {
  const explicit = env.HITLY_MAIL_TRANSPORT?.trim().toLowerCase()
  if (explicit && TRANSPORTS.has(explicit as TransportName)) return explicit as TransportName
  if (env.SMTP_HOST?.trim()) return 'smtp'
  if (env.RESEND_API_KEY?.trim()) return 'resend'
  return 'console'
}
