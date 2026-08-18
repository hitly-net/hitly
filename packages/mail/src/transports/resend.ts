import type { MailResult, ResolvedMail } from '../types'

export async function sendResend(message: ResolvedMail): Promise<MailResult> {
  const resendKey = process.env.RESEND_API_KEY?.trim()
  if (!resendKey) {
    throw new Error('RESEND_API_KEY is required for HITLY_MAIL_TRANSPORT=resend')
  }
  const body: Record<string, unknown> = {
    from: message.from,
    to: [message.to],
    subject: message.subject,
    text: message.text,
  }
  if (message.html) body.html = message.html
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resendKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`Resend failed (${response.status}): ${await response.text()}`)
  }
  return { delivered: true }
}
