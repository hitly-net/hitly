# Email (`packages/mail`)

## Purpose

The single outbound mailer for the whole monorepo: one `sendMail` facade with
pluggable transports. The host never talks to an SMTP or vendor API
directly.

## Where it lives

- `packages/mail/src/index.ts` - `sendMail()` facade and default sender.
- `packages/mail/src/resolve-transport.ts` - picks a transport: explicit
  `HITLY_MAIL_TRANSPORT`, else `smtp` if `SMTP_HOST` is set, else `resend`
  if `RESEND_API_KEY` is set, else `console` (dev default; nothing leaves
  the process).
- `packages/mail/src/transports/` - `console.ts`, `memory.ts` (test double,
  inspectable via `sentMail`/`clearSentMail`), `smtp.ts`, `resend.ts`.
- `packages/mail/src/types.ts` - `MailMessage`, `MailResult`,
  `TransportName`.
- `apps/app/lib/mail.ts` - thin re-export consumed by the host.

## Who sends what

- `apps/app/lib/notify.ts` - "decision needed" notifications to the
  assignee, gated by enabled project channels. Channel types are an enum of
  `email | slack | telegram` (`@hitly/core`); only `email` delivers - the
  others are recorded in the project event log as "not implemented yet".
- `apps/app/lib/auth.ts`, `password-change-route.ts`, `email-change-route.ts` -
  email verification, password reset, email-change confirmation.
- `apps/app/lib/invites.ts`, `actions/team.ts` - workspace invitations.

## Key interfaces

- `sendMail({ to, subject, text, ... })` resolves the sender (message-level
  override, then `HITLY_MAIL_FROM`, then a built-in default) and returns a
  `MailResult` with `delivered`/`reason` - callers log outcomes as project
  events rather than treating mail as a hard dependency. Delivery failures
  never fail a reviewer or origin action.

## How it talks to the others

- Called in-process by `apps/app` only (plus its own tests). Outbound: an
  SMTP relay or the Resend API, chosen by configuration.
- The link in a notification points at the host inbox under `BETTER_AUTH_URL`
  / `NEXT_PUBLIC_APP_URL` (host-side variable, see
  [web-app.md](web-app.md)).

## Configuration (variable names only)

`HITLY_MAIL_TRANSPORT`, `HITLY_MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `RESEND_API_KEY`.

## Unconfirmed

- Slack/Telegram delivery (types exist; no implementation in this repo).
