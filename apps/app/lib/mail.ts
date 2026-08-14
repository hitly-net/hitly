export async function sendMail(args: { to: string; subject: string; text: string }) {
  const resendKey = process.env.RESEND_API_KEY
  const from = process.env.HITLY_MAIL_FROM ?? 'Hitly <noreply@hitly.net>'
  if (!resendKey) {
    console.info(`[hitly mail skipped] to=${args.to} subject=${args.subject}\n${args.text}`)
    return { delivered: false as const, reason: 'no_mailer' }
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resendKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [args.to],
      subject: args.subject,
      text: args.text,
    }),
  })
  if (!response.ok) {
    throw new Error(`Resend failed (${response.status}): ${await response.text()}`)
  }
  return { delivered: true as const }
}
