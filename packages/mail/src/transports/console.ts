import type { MailResult, ResolvedMail } from '../types'

export async function sendConsole(message: ResolvedMail): Promise<MailResult> {
  console.info(`[hitly mail skipped] to=${message.to} subject=${message.subject}\n${message.text}`)
  return { delivered: false, reason: 'no_mailer' }
}
