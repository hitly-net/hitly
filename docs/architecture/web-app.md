# Web app (`apps/app`)

## Purpose

The central Next.js application (App Router). It is simultaneously the
reviewer inbox UI, the authentication surface, the admin surface (projects,
team, settings, audit), and the HTTP host that owns approvals. Everything
durable flows through this app: ingest, notification fan-out, decision
recording, evidence, and resume dispatch. Self-hosted it runs the open-source
edition; the private cloud overlay swaps `@hitly/cloud` to add billing and
hosted-only behavior (see [cloud.md](cloud.md)).

## Where it lives

- `apps/app/app/` - App Router pages: `inbox`, `audit`, `connections`,
  `projects`, `settings` (including billing pages), `invite`, `login`,
  `signup`, `verify-email`, `verify-email-change`, `forgot-password`,
  `reset-password`, plus `api/` (see [rest-api.md](rest-api.md)).
- `apps/app/app/.well-known/` - app site association and asset links routes
  that back mobile deep links.
- `apps/app/lib/` - server logic: `auth.ts` (Better Auth wiring),
  `approvals.ts` (ingest, decide, resume dispatch), `plugins.ts` (plugin
  registry), `notify.ts` (email/push fan-out), `push.ts` and `push-tokens.ts`
  (see [push.md](push.md)), `evidence*.ts`, `events.ts` (project event log),
  `tenant.ts` and `tenant-crypto.ts` (workspace scoping and at-rest
  encryption of origin refs / credentials), `housekeeping/` (scheduled jobs),
  `inbox.ts`, `rbac.ts`, `cors.ts`, `db-pool.ts`, `hitl-response.ts`.
- `apps/app/actions/` - server actions for projects, team, workspace, OTel.
- `apps/app/instrumentation.ts` - startup checks (refuses production boot with
  a missing/weak auth secret, dev DB password, malformed proxy or pool
  config), housekeeping registration, destination-policy notice.
- `apps/app/components/` - inbox shell, sidebar (nav comes from the edition),
  auth layout.

## Key interfaces

- Browser-facing: the inbox (`/inbox`, per-approval detail), project/config
  pages, audit log, team settings. Server components + server actions.
- `getPlugin(id)` in `lib/plugins.ts` maps a plugin id to a
  `HitlyPlugin` implementation from `packages/plugin-*` (imported directly,
  in-process).
- Decision dispatch: `lib/approvals.ts` records the decision, appends
  evidence (fail-closed on sink errors), then calls the plugin's `resume`.
  `ensureProjectResumeSecret` / `ensureProjectWebhookSecret` provision the
  per-project signing credentials used by outbound callbacks.
- Auth: Better Auth mounted at `/api/auth/[...all]` with email/password,
  email verification, MFA (TOTP + recovery codes + challenges), email change.

## How it talks to the others

- Postgres through `@hitly/db` (Drizzle pool in `lib/db-pool.ts`).
- Origins through the plugins: resume callbacks, Mastra/LangGraph/Temporal/
  OpenShell resumes, HTTP `resumeUrl` POSTs (see [plugins.md](plugins.md)).
- Reviewers through the browser, and through the mobile app via
  `/api/v1/*` (see [rest-api.md](rest-api.md)).
- MCP server as a client of its REST API.
- `packages/mail` for outbound email; the Expo push service for mobile.
- `@hitly/cloud` for the edition object (entitlements, nav items, billing
  slots) and `@hitly/ui` for shared primitives; both are transpiled
  workspace deps (`transpilePackages` in `next.config.mjs`).

## Configuration (variable names only)

Core: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_WEB_URL`, `WEB_URL`.
Hardening/limits: `HITLY_SIGNUP_ENABLED`, `HITLY_REQUIRE_VERIFIED_EMAIL`,
`HITLY_CORS_ALLOWED_ORIGINS`,
`HITLY_TRUSTED_PROXIES`, `HITLY_DB_CONNECTION_TIMEOUT_MS`,
`HITLY_DB_POOL_MAX`, `HITLY_CREATE_ONCE_RETENTION_DAYS`.
Cryptography: `HITLY_ENCRYPTION_KEK`, `HITLY_MFA_ENCRYPTION_KEY`.
Cron: `HITLY_CRON_SECRET`, `HITLY_HOUSEKEEPING`.
Mail/push (delegated, listed on their pages): `HITLY_MAIL_TRANSPORT`,
`HITLY_MAIL_FROM`, `EXPO_ACCESS_TOKEN`, `HITLY_EXPO_ORIGIN`.
Deep links: `HITLY_MOBILE_APP_ID`, `HITLY_IOS_TEAM_ID`,
`HITLY_ANDROID_SHA256`.
Marketing funnel: `WAITLIST_WEBHOOK_URL`.

## Verified-email gate (`HITLY_REQUIRE_VERIFIED_EMAIL`)

Defaults OFF (closed beta does not block); GA ships it ON. The value is
parsed by the same shared parser as the other boolean flags
(`lib/boolean-flag.ts`): `1` / `true` / `yes` / `on` enable it, `0` /
`false` / `off` disable it (compared after trim + lowercase, so `TRUE` or
`1 ` are ON), unset leaves it at its default, and an unrecognised value
also falls back to the default with one startup warning that names the
variable but never its value. Read per call, so the deployment can flip it
without a code change.

While ON, a user whose `users.email_verified` is false can still sign in,
but:

- creating projects or project API keys is refused server-side. The check
  lives in the shared create helpers (`lib/project-create.ts`), the only
  server-side writers of the `projects` and `projectApiKeys` tables, so web
  server actions and any REST `/api/v1` or MCP create path all pass through
  it. The refusal carries the stable code `email_not_verified` and a
  user-facing instruction to verify; REST/MCP callers get HTTP 403 with
  `{ "error": "email_not_verified", "message": ... }`.
- regenerating an existing project API key is gated the same way as
  creating one: rotation goes through `rotateProjectApiKeyRecord` in
  `lib/project-create.ts`, so a refused regenerate leaves the stored key
  (hash and prefix) untouched and produces no new secret.
- sending or resending a workspace invite is refused: the gate sits in the
  single invite paths (`createAndSendWorkspaceInvite` /
  `resendWorkspaceInvite` in `lib/invites.ts`) before the invite row is
  written or the token rotated, so nothing is written and no invite email
  goes out.
- adding an EXISTING account to the workspace is refused the same way: the
  gate runs in the single add path (`addExistingUserToWorkspace` in
  `lib/invites.ts`) for any role, before the membership row is written and
  before the "added to workspace" mail, so a blocked add writes nothing and
  sends no mail.
- regenerating a project resume secret is gated like an API-key regenerate:
  the gate runs in `rotateProjectResumeSecret` (`lib/resume-secret.ts`)
  before the stored credentials are rewritten, so a refused rotation leaves
  the current resume secret intact and produces no new one. This is a
  web-only action; there is no REST `/api/v1` or MCP resume-secret
  regeneration surface today, and any future one must go through the same
  chokepoint.
- work-item notifications are suppressed for the unverified recipient: no
  decision email, no push (`lib/notify.ts`).
- the signed-in app shell shows a banner naming what the gate holds with a
  resend-verification link; the resend reuses the existing rate-limited
  signed-in endpoint `POST /api/session/resend-email-verification`.
- a gate-blocked web create (project, API key, invite send/resend, resume
  secret regenerate) is NOT a
  crash: the server action returns the typed result
  `{ status: 'error', code: 'email_not_verified', message }` and the client
  renders the shared "Verify your email to continue" state with the same
  resend-verification link — never a 500, stack trace or raw error id.
  The gate error always throws out of the tenant transaction (so anything
  written before it rolls back); the typed result is produced only outside.

Account-security mail (verification, resend, password reset, email change)
is never gated and always sends while the flag is on.

## Unconfirmed

- Exact production deployment topology (containerization, reverse proxy) is
  not defined in this repo.
