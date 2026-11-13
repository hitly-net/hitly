# REST API host (`apps/app/app/api/v1`)

## Purpose

The HTTP surface of the host application. It is not a separate process: it is
the route-handler layer of the Next.js app in `apps/app`. Origins create and
query approvals here; reviewers (web and mobile) read and decide here; the
MCP server is a client of it.

## Where it lives

`apps/app/app/api/v1/` (plus `/api/auth/[...all]` for Better Auth and
`/api/stripe/*`, `/api/waitlist` outside v1).

Route groups (from the route tree):

| Area | Routes |
| --- | --- |
| Approvals | `POST/GET /approvals`, `GET /approvals/by-run-id`, `GET /approvals/{id}`, `POST /approvals/{id}/decide`, `/cancel`, `/retry-resume`, `/presented`, `/opens`, `/original-request` |
| Inbox | `GET /inbox`, `GET /inbox/summary` |
| Projects | `GET /projects` (list), `GET /projects/{id}`, `GET/PATCH /projects/{id}/config`, `POST /projects/{id}/test-evidence-sink`. Project create/update and API-key management are server actions (`createProject`, `updateProjectConfig`, `createProjectApiKey`, ... in `apps/app/actions/projects.ts`), not REST routes. |
| Push | `POST/DELETE /push-tokens`, `POST/DELETE /devices` |
| Team/invites | `GET/PATCH /workspace`, `POST /invites/lookup`, `POST /invites/accept` |
| Ops | `GET /health`, `POST /housekeeping`, `GET /signup-status` |

Session-auth routes outside v1: `/api/auth/[...all]` (Better Auth) and
`/api/session/*` - `mfa/{enrol,verify,disable,recovery-codes,confirm}`,
`change-password`, `change-email`, `verify-email-change`, `verify-email`,
`resend-email-verification`, `sign-out` (all POST).

## Key interfaces

- Two credential planes:
  - Project API keys (`hitly_...`, issued per project, stored hashed in
    `project_api_keys`) authorize the requester plane: creating approvals
    (`POST /approvals`), key-scoped pending listing
    (`GET /approvals?status=open`, the host endpoint behind MCP
    `list_pending`), reading by run id, fetching the original request, and
    requester cancel (`POST /approvals/{id}/cancel` - a Bearer that is not a
    valid API key falls through to the reviewer-session path). Send as
    `Authorization: Bearer`.
  - Human sessions (Better Auth) authorize reviewer actions: inbox reads,
    decisions, presented/opened telemetry, cancel and retry.
- Idempotency: approval creation honors an `idempotency-key` header (the MCP
  server uses it on every create).
- Workspace scoping: reviewer requests carry a workspace header; requests
  from the mobile app carry a client hint that the host folds into evidence.
- Decisions carry the decision value (accept, reject, edit, respond, ignore,
  cancel) plus optional edited args and typed answers, validated against the
  request's answer gates.
- Outbound (documented here because it is the mirror of this surface):
  resume/decided callbacks into origins carry an event id header for
  dedupe, optional HMAC signature headers, and optional lifecycle events -
  implemented in `@hitly/plugin-http` (see [plugins.md](plugins.md)).

## How it talks to the others

- Handlers call the same `apps/app/lib` functions the UI uses
  (`approvals.ts`, `inbox.ts`, `push-tokens.ts`), so there is one
  implementation per behavior.
- Through the plugin registry it reaches origins for resume.
- All persistence through `@hitly/db`.

## Configuration (variable names only)

Same as the web app host, since it is the same process: `DATABASE_URL`,
`BETTER_AUTH_URL`, `HITLY_CORS_ALLOWED_ORIGINS`, `HITLY_TRUSTED_PROXIES`,
`HITLY_CRON_SECRET` (authorizes `POST /housekeeping`), `HITLY_SIGNUP_ENABLED`
(drives `/signup-status`), `HITLY_REQUIRE_VERIFIED_EMAIL` (GA gate, below).

## Verified-email gate

While `HITLY_REQUIRE_VERIFIED_EMAIL` is on, creating projects or project API
keys with an unverified address is refused server-side inside the shared
create helpers (`apps/app/lib/project-create.ts`) that back every create
path - web server actions today, and any REST `/api/v1` or MCP create path
that uses them (the API does not yet expose project/key creation directly;
when it does it must go through those helpers, enforced by a source-scan
test). Key regeneration is gated identically through
`rotateProjectApiKeyRecord` in the same file (the API does not expose a
regenerate route today either). Project resume-secret regeneration is
gated identically through `rotateProjectResumeSecret` in
`apps/app/lib/resume-secret.ts` (again no REST or MCP route exposes it
today; a future one must use that chokepoint). Workspace invite sends/
resends and adding an EXISTING account to a workspace are gated in the
single invite paths (`apps/app/lib/invites.ts`): nothing is written and
no email goes out. The refusal is HTTP 403 with a stable machine-readable
code:

```json
{ "error": "email_not_verified", "message": "Verify your email address to create projects and API keys..." }
```

Work-item notification dispatch (decision email, push) additionally skips
unverified recipients while the flag is on; verification and password-reset
mail is never suppressed. See [web-app.md](web-app.md).

## Unconfirmed

- The full public API reference is maintained as docs content in `apps/web`;
  this page reflects the route tree, not necessarily every field.
