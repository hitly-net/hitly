export type TransportName = 'console' | 'smtp' | 'resend' | 'memory'

export type MailMessage = {
  to: string
  subject: string
  text: string
  html?: string
  from?: string
}

export type MailResult = { delivered: true } | { delivered: false; reason: string }

export type ResolvedMail = MailMessage & { from: string }
