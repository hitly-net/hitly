import { resolveTransportName } from './resolve-transport'
import { sendConsole } from './transports/console'
import { sendMemory } from './transports/memory'
import { sendResend } from './transports/resend'
import { sendSmtp } from './transports/smtp'
import type { MailMessage, MailResult, ResolvedMail } from './types'

export const DEFAULT_FROM = 'Hitly <noreply@hitly.net>'

export type { MailMessage, MailResult, TransportName } from './types'
export { resolveTransportName } from './resolve-transport'
export { clearSentMail, sentMail } from './transports/memory'

function resolveMessage(args: MailMessage): ResolvedMail {
  return {
    ...args,
    from: args.from || process.env.HITLY_MAIL_FROM || DEFAULT_FROM,
  }
}

export async function sendMail(args: MailMessage): Promise<MailResult> {
  const message = resolveMessage(args)
  switch (resolveTransportName()) {
    case 'smtp':
      return sendSmtp(message)
    case 'resend':
      return sendResend(message)
    case 'memory':
      return sendMemory(message)
    default:
      return sendConsole(message)
  }
}
