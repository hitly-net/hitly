/**
 * Shared Postgres pool settings for drizzle and Better Auth (lib/db.ts).
 *
 * MFA confirm holds one connection for its transaction while Better Auth
 * revokeOtherSessions takes a second. A pool of max < 3 cannot serve that
 * (plus anything else in flight). connectionTimeoutMillis bounds the wait
 * when the pool is exhausted, instead of hanging forever.
 *
 * HITLY_DB_CONNECTION_TIMEOUT_MS default 5000; HITLY_DB_POOL_MAX default 10
 * (node-postgres's default). Both are checked at start in every environment.
 * Neither is a secret; messages name the variable and never a URL or password.
 */

import pg from 'pg'

export const DB_CONNECTION_TIMEOUT_MS_ENV = 'HITLY_DB_CONNECTION_TIMEOUT_MS'
export const DB_POOL_MAX_ENV = 'HITLY_DB_POOL_MAX'
export const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 5000
export const DEFAULT_DB_POOL_MAX = 10
export const MIN_DB_POOL_MAX = 3

const POSITIVE_INT = /^[1-9]\d*$/

export function dbConnectionTimeoutMsProblem(value: string | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw) return null
  if (!POSITIVE_INT.test(raw)) return `${DB_CONNECTION_TIMEOUT_MS_ENV} must be a positive integer`
  return null
}

export function dbPoolMaxProblem(value: string | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw) return null
  if (!POSITIVE_INT.test(raw) || Number(raw) < MIN_DB_POOL_MAX) {
    return `${DB_POOL_MAX_ENV} must be at least ${MIN_DB_POOL_MAX}`
  }
  return null
}

export function resolveDbConnectionTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[DB_CONNECTION_TIMEOUT_MS_ENV]?.trim()
  if (!raw) return DEFAULT_DB_CONNECTION_TIMEOUT_MS
  return Number(raw)
}

export function resolveDbPoolMax(env: Record<string, string | undefined> = process.env): number {
  const raw = env[DB_POOL_MAX_ENV]?.trim()
  if (!raw) return DEFAULT_DB_POOL_MAX
  return Number(raw)
}

export function postgresPoolOptions(env: Record<string, string | undefined> = process.env): {
  max: number
  connectionTimeoutMillis: number
} {
  return {
    max: resolveDbPoolMax(env),
    connectionTimeoutMillis: resolveDbConnectionTimeoutMs(env),
  }
}

export function createAppPool(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
): pg.Pool {
  return new pg.Pool({
    connectionString,
    ...postgresPoolOptions(env),
  })
}
