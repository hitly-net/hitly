# @hitly/mail

Outbound transactional mailer. Callers pass `{ to, subject, text }`. Transport is selected from env.

| `HITLY_MAIL_TRANSPORT` | When to use |
| --- | --- |
| `console` | Default. Logs the message; `{ delivered: false, reason: 'no_mailer' }`. |
| `smtp` | Nodemailer. Dev/test: Mailpit on `127.0.0.1:1025`. Self-host: any SMTP. |
| `resend` | Resend HTTP API (Hitly Cloud production). |
| `memory` | Tests. Messages accumulate in `sentMail`. |

If `HITLY_MAIL_TRANSPORT` is unset: `SMTP_HOST` → smtp, else `RESEND_API_KEY` → resend, else console. SMTP wins over Resend so a leftover API key cannot send real mail from a laptop that also has Mailpit.

| Env | Notes |
| --- | --- |
| `HITLY_MAIL_FROM` | Default `Hitly <noreply@hitly.net>`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | SMTP. Port defaults to 587; Mailpit uses 1025. |
| `RESEND_API_KEY` | Required for the Resend transport. |
