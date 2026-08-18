import nodemailer from 'nodemailer'
import type { MailResult, ResolvedMail } from '../types'

function isSecure(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true'
}

export async function sendSmtp(message: ResolvedMail): Promise<MailResult> {
  const host = process.env.SMTP_HOST?.trim()
  if (!host) {
    throw new Error('SMTP_HOST is required for HITLY_MAIL_TRANSPORT=smtp')
  }
  const port = Number(process.env.SMTP_PORT ?? '587')
  const user = process.env.SMTP_USER?.trim()
  const pass = process.env.SMTP_PASS
  const transporter = nodemailer.createTransport({
    host,
    port: Number.isFinite(port) ? port : 587,
    secure: isSecure(process.env.SMTP_SECURE),
    auth: user ? { user, pass: pass ?? '' } : undefined,
  })
  await transporter.sendMail({
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  })
  return { delivered: true }
}
