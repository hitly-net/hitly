import type { MailResult, ResolvedMail } from '../types'

/**
 * Fallback when no mailer is configured. Outside production it prints the
 * message for local development. In production: no reset links in prod logs.
 */
export async function sendConsole(message: ResolvedMail, env: NodeJS.ProcessEnv = process.env): Promise<MailResult> {
  if (env.NODE_ENV === 'production') {
    console.info('[hitly mail skipped] no mailer configured; message suppressed')
  } else {
    console.info(`[hitly mail skipped] to=${message.to} subject=${message.subject}\n${message.text}`)
  }
  return { delivered: false, reason: 'no_mailer' }
}
