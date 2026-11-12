/**
 * Shared Postgres-backed rate limiting (the limiter every HITLy process
 * counts into, so limits hold across replicas).
 *
 * A bucket is one (route, subject) pair — route names the endpoint family
 * ('mfa-verify', 'ingest', ...) and subject is the client's IP, account or
 * API key. Only the SHA-256 hex of `route + NUL + subject` is stored, so the
 * table never holds a raw address, email or key; the plain route name is kept
 * alongside for operators (it is never a secret).
 *
 * Counting is one atomic statement: `INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING`. A bucket holds a fixed window: the first request opens it, the
 * limit applies until `expires_at`, and the first request after expiry opens a
 * new window. Two limiter instances pointed at the same database therefore
 * share one counter, and racing requests cannot both slip past the last slot
 * (the row update serialises them).
 *
 * Expired buckets are removed by a throttled sweep that runs opportunistically
 * from `acquire` (at most once per `sweepIntervalMs` per process); `sweepExpired`
 * is exported so callers and tests can run it directly.
 *
 * When the database is unavailable the limiter falls back to the same
 * fixed-window counting in process memory and logs ONE line (never repeated).
 * That fallback keeps the endpoint protected while the database is down, but
 * its counters are per server process — see the ops docs. It never stores or
 * logs a raw subject: fallback keys are the same hash.
 */

import { createHash } from 'node:crypto'

export type RateLimitRule = { limit: number; windowMs: number }

export type RateLimitDecision = {
  /** True when this request fits inside the window's budget. */
  allowed: boolean
  /** Milliseconds until the window frees up; 0 when allowed. */
  retryAfterMs: number
  /** The bucket's count for this window after this request. */
  count: number
}

/** The slice of `pg.Pool` the limiter needs (tests inject a stand-in). */
export interface RateLimitQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

/** A `RateLimitQueryable` the creator can release (what `pg.Pool` gives). */
export interface RateLimitPool extends RateLimitQueryable {
  end(): Promise<void>
}

/**
 * A small `pg.Pool` for a process that has no pool yet (the standalone MCP
 * server). `pg` is imported lazily so memory-only deployments never load it.
 */
export async function createDefaultRateLimitPool(connectionString: string, max = 2): Promise<RateLimitPool> {
  const imported = await import('pg')
  const mod = ((imported as { default?: unknown }).default ?? imported) as {
    Pool: new (config: Record<string, unknown>) => RateLimitPool
  }
  return new mod.Pool({ connectionString, max })
}

export interface SharedRateLimiterOptions {
  /** The pool to count into; null counts in process memory only. */
  pool: RateLimitQueryable | null
  /** Clock for windows and sweeps (tests); defaults to wall time. */
  now?: () => number
  /** Where the one-off fallback line goes; defaults to console.warn. */
  log?: (line: string) => void
  /** Minimum gap between expiry sweeps per process. Default 60_000 ms. */
  sweepIntervalMs?: number
  /** Ceiling for in-memory fallback buckets; oldest evicted first. Default 10_000. */
  maxFallbackKeys?: number
}

export interface SharedRateLimiter {
  /** Record one request for (route, subject) against the rule. */
  acquire(route: string, subject: string, rule: RateLimitRule): Promise<RateLimitDecision>
  /** Delete buckets whose window has expired; returns the number removed. */
  sweepExpired(): Promise<number>
}

/** The stored bucket key: SHA-256 over route + NUL + subject. Never reversible. */
export function rateLimitBucketKey(route: string, subject: string): string {
  return createHash('sha256').update(`${route}\u0000${subject}`, 'utf8').digest('hex')
}

/** One line per limiter instance, naming the failure but never a subject. */
export function rateLimitFallbackLogLine(errorName: string): string {
  return `[hitly rate-limit] Database unavailable (${errorName}); using the per-process fallback limiter until it recovers. Fallback counters are per server process.`
}

const ACQUIRE_SQL = `
INSERT INTO rate_limit_buckets AS b (bucket_key, route, count, window_start, expires_at)
VALUES ($1, $2, 1, $3, $4)
ON CONFLICT (bucket_key) DO UPDATE SET
  count        = CASE WHEN b.expires_at <= $3 THEN 1 ELSE b.count + 1 END,
  window_start = CASE WHEN b.expires_at <= $3 THEN $3 ELSE b.window_start END,
  expires_at   = CASE WHEN b.expires_at <= $3 THEN $4 ELSE b.expires_at END
RETURNING count, expires_at
`

const SWEEP_SQL = 'DELETE FROM rate_limit_buckets WHERE expires_at < $1'

type AcquireRow = { count: number; expires_at: Date | string }

function toDecision(row: AcquireRow, rule: RateLimitRule, now: number): RateLimitDecision {
  const expiresAt = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(String(row.expires_at))
  const allowed = row.count <= rule.limit
  return { allowed, retryAfterMs: allowed ? 0 : Math.max(0, expiresAt - now), count: row.count }
}

/** Fixed-window in-process counting, mirroring the SQL semantics. */
function createMemoryFallback(maxKeys: number, now: () => number) {
  const windows = new Map<string, { count: number; resetAt: number }>()
  return (key: string, rule: RateLimitRule): RateLimitDecision => {
    const at = now()
    let entry = windows.get(key)
    if (!entry || entry.resetAt <= at) {
      windows.delete(key)
      while (windows.size >= maxKeys) {
        let evicted = false
        for (const [stale, bucket] of windows) {
          if (bucket.resetAt <= at) {
            windows.delete(stale)
            evicted = true
          } else break
        }
        if (!evicted) {
          const oldest = windows.keys().next()
          if (oldest.done) break
          windows.delete(oldest.value)
        }
      }
      entry = { count: 0, resetAt: at + rule.windowMs }
      windows.set(key, entry)
    }
    entry.count += 1
    return {
      allowed: entry.count <= rule.limit,
      retryAfterMs: entry.count <= rule.limit ? 0 : Math.max(0, entry.resetAt - at),
      count: entry.count,
    }
  }
}

export function createSharedRateLimiter(options: SharedRateLimiterOptions): SharedRateLimiter {
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => console.warn(line))
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000
  const fallback = createMemoryFallback(options.maxFallbackKeys ?? 10_000, now)
  let fallbackLogged = false
  let lastSweepAt = 0

  const noteFallback = (error: unknown) => {
    if (fallbackLogged) return
    fallbackLogged = true
    const name = error instanceof Error ? (error.name || 'Error') : 'Error'
    log(rateLimitFallbackLogLine(name))
  }

  const sweepExpired = async (): Promise<number> => {
    if (!options.pool) return 0
    const result = await options.pool.query(SWEEP_SQL, [new Date(now())])
    const rowCount = (result as { rows: unknown[]; rowCount?: number }).rowCount
    return typeof rowCount === 'number' ? rowCount : (result.rows?.length ?? 0)
  }

  return {
    async acquire(route, subject, rule) {
      if (rule.limit <= 0 || rule.windowMs <= 0) return { allowed: true, retryAfterMs: 0, count: 0 }
      if (!options.pool) return fallback(rateLimitBucketKey(route, subject), rule)
      const at = now()
      const key = rateLimitBucketKey(route, subject)
      try {
        const result = await options.pool.query(ACQUIRE_SQL, [key, route, new Date(at), new Date(at + rule.windowMs)])
        const row = result.rows[0] as AcquireRow | undefined
        if (!row) throw new Error('rate limit acquire returned no row')
        // Opportunistic housekeeping, throttled per process; never blocks the decision.
        if (at - lastSweepAt >= sweepIntervalMs) {
          lastSweepAt = at
          sweepExpired().catch(() => undefined)
        }
        return toDecision(row, rule, at)
      } catch (error) {
        noteFallback(error)
        return fallback(key, rule)
      }
    },
    async sweepExpired() {
      try {
        return await sweepExpired()
      } catch (error) {
        noteFallback(error)
        return 0
      }
    },
  }
}

/**
 * One rule's env override: HITLY_RATE_LIMIT_<NAME>_LIMIT and
 * HITLY_RATE_LIMIT_<NAME>_WINDOW_MS, where NAME is the limiter name upper-cased
 * with '-' replaced by '_'. Anything that is not a whole number (or is below
 * `min`) is a startup error naming the variable — never a silent surprise.
 */
export function rateLimitRuleFromEnv(
  name: string,
  defaults: RateLimitRule,
  env: Record<string, string | undefined> = process.env,
): RateLimitRule {
  const prefix = `HITLY_RATE_LIMIT_${name.toUpperCase().replace(/-/g, '_')}`
  const parse = (variable: string, raw: string | undefined, fallback: number, min: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback
    if (!/^\d+$/.test(raw.trim())) throw new Error(`${variable} must be a whole number of at least ${min}`)
    const value = Number(raw.trim())
    if (value < min) throw new Error(`${variable} must be a whole number of at least ${min}`)
    return value
  }
  return {
    limit: parse(`${prefix}_LIMIT`, env[`${prefix}_LIMIT`], defaults.limit, 0),
    windowMs: parse(`${prefix}_WINDOW_MS`, env[`${prefix}_WINDOW_MS`], defaults.windowMs, 1),
  }
}
