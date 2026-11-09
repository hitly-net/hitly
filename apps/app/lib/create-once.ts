/**
 * Create-once retention (hitl-spec 3.2).
 *
 * A repeat submission with the same `Idempotency-Key` in the same project
 * returns the existing request, and never creates a second ask, when either:
 *
 * - the existing request is still open (`pending` or `failed_resume`), at any
 *   age; or
 * - it is closed (`decided`, `expired` or `cancelled`) and was created less
 *   than the create-once retention period ago.
 *
 * After the period, the same key MAY create a new request. The period is
 * published in every ingest response (`createOnce.retentionSeconds`) and in
 * the API docs. Requesters should keep their single-use record for a spent
 * requestId (hitl-spec 3.8) at least this long.
 *
 * Default 10 days: the shortest Cloud plan keeps closed items for 10 days
 * after they close (`completedRetentionDays`), so a request is always still
 * stored for the whole window. Self-hosted operators may set
 * HITLY_CREATE_ONCE_RETENTION_DAYS (whole days, 1-3650).
 */

export type CreateOnceEnv = Record<string, string | undefined>

export const DEFAULT_CREATE_ONCE_RETENTION_DAYS = 10
const MAX_DAYS = 3650
const DAY_MS = 24 * 60 * 60 * 1000

export function createOnceRetentionDays(env: CreateOnceEnv = process.env): number {
  const raw = env.HITLY_CREATE_ONCE_RETENTION_DAYS?.trim()
  if (!raw) return DEFAULT_CREATE_ONCE_RETENTION_DAYS
  if (!/^\d+$/.test(raw)) return DEFAULT_CREATE_ONCE_RETENTION_DAYS
  const days = Number(raw)
  if (days < 1 || days > MAX_DAYS) return DEFAULT_CREATE_ONCE_RETENTION_DAYS
  return days
}

export function createOnceRetentionMs(env: CreateOnceEnv = process.env): number {
  return createOnceRetentionDays(env) * DAY_MS
}

/** Oldest `createdAt` a closed request may have and still be replayed (exclusive). */
export function createOnceCutoff(now: number = Date.now(), env: CreateOnceEnv = process.env): Date {
  return new Date(now - createOnceRetentionMs(env))
}

/** True when a request created at `createdAt` is inside the window at `now` (strict: the boundary instant is outside). */
export function withinCreateOnceWindow(createdAt: Date, now: number = Date.now(), env: CreateOnceEnv = process.env) {
  return createdAt.getTime() > createOnceCutoff(now, env).getTime()
}

export function createOncePolicy(env: CreateOnceEnv = process.env) {
  return { retentionSeconds: createOnceRetentionDays(env) * 24 * 60 * 60 }
}
