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
Hardening/limits: `HITLY_SIGNUP_ENABLED`, `HITLY_CORS_ALLOWED_ORIGINS`,
`HITLY_TRUSTED_PROXIES`, `HITLY_DB_CONNECTION_TIMEOUT_MS`,
`HITLY_DB_POOL_MAX`, `HITLY_CREATE_ONCE_RETENTION_DAYS`.
Cryptography: `HITLY_ENCRYPTION_KEK`, `HITLY_MFA_ENCRYPTION_KEY`.
Cron: `HITLY_CRON_SECRET`, `HITLY_HOUSEKEEPING`.
Mail/push (delegated, listed on their pages): `HITLY_MAIL_TRANSPORT`,
`HITLY_MAIL_FROM`, `EXPO_ACCESS_TOKEN`, `HITLY_EXPO_ORIGIN`.
Deep links: `HITLY_MOBILE_APP_ID`, `HITLY_IOS_TEAM_ID`,
`HITLY_ANDROID_SHA256`.
Marketing funnel: `WAITLIST_WEBHOOK_URL`.

## Unconfirmed

- Exact production deployment topology (containerization, reverse proxy) is
  not defined in this repo.
