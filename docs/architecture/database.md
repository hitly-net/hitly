# Database (`packages/db`)

## Purpose

The system of record. All durable state - users, auth, workspaces, projects,
approvals, decisions, evidence, channels, devices, housekeeping - lives in a
single Postgres database accessed through one Drizzle schema.

## Where it lives

- `packages/db/src/schema.ts` - the Drizzle schema (25 tables).
- `packages/db/src/index.ts` - re-export surface (`@hitly/db`, plus the
  `/schema` subpath most consumers import).
- `packages/db/drizzle/` - generated SQL migrations (numbered `0000..`,
  starting with `0000_oval_wendell_rand.sql`), managed with
  `yarn db:generate` / `yarn db:migrate`.
- `docker-compose.yml` (repo root) - local Postgres for `yarn db:up`.

## Tables (from the schema)

- Identity/auth: `users`, `sessions`, `accounts`, `verifications`,
  `pending_email_changes`, `user_mfa`, `user_mfa_recovery_codes`,
  `user_mfa_challenges`, `account_security_events`.
- Tenancy: `workspaces`, `memberships`, `invites`, `projects`,
  `project_memberships`, `project_api_keys`, `project_rules`,
  `project_channels`, `workspace_otel_endpoints`.
- Approval spine: `approvals`, `decision_records`, `project_events`,
  `evidence_receipts`.
- Devices: `user_devices`, `push_tokens`.
- Ops: `housekeeping_jobs`.

## Key interfaces

- Consumers (all in `apps/app`) import `@hitly/db/schema` and open
  connections through the host's pool helpers (`apps/app/lib/db.ts`,
  `db-pool.ts`); CI starts from a clean database with `yarn db:migrate`.
- The plugin layer never touches the database; it receives decoded
  `OriginRef`/credentials values from the host.

## Multi-tenancy and at-rest protection (host-enforced)

- Every tenant read/write in `apps/app` goes through workspace-scoped
  helpers (`lib/tenant.ts`); the OSS edition enforces scoping in the
  application layer (no row-level security in public code - the private
  cloud overlay may add it, unconfirmed).
- Sensitive origin data (approval `origin`, project credentials) is stored
  encrypted per tenant and decoded on use (`lib/tenant-crypto.ts`), keyed by
  the host's KEK variables.
- `approvals` carries a `(workspace, created_at, id)` index used by the
  open-status keyset pagination (see migration `0011`).

## Configuration (variable names only)

`DATABASE_URL` (the only one the package itself needs), plus host pool
tuning: `HITLY_DB_CONNECTION_TIMEOUT_MS`, `HITLY_DB_POOL_MAX` (minimum pool
size is enforced at startup).

## Unconfirmed

- Production Postgres provisioning/backup topology is not in this repo.
