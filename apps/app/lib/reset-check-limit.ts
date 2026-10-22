/**
 * A small in-memory limiter for the reset page's link check. The page calls
 * Better Auth in process, which skips Better Auth's own request limiter, so
 * this keeps the page from answering an unlimited number of checks for one
 * client. When a client is over the limit the page shows the "couldn't check
 * this link right now" state instead of the form.
 *
 * The limit is per server process. It never stores or logs the token.
 */

export type RateLimiter = (key: string) => boolean

export function createRateLimiter({
  limit,
  windowMs,
  maxKeys = 10_000,
  now = Date.now,
}: {
  limit: number
  windowMs: number
  maxKeys?: number
  now?: () => number
}): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>()
  return (key) => {
    const time = now()
    let entry = windows.get(key)
    if (!entry || entry.resetAt <= time) {
      if (!entry && windows.size >= maxKeys) {
        for (const [k, v] of windows) if (v.resetAt <= time) windows.delete(k)
        if (windows.size >= maxKeys) windows.clear()
      }
      entry = { count: 0, resetAt: time + windowMs }
      windows.set(key, entry)
    }
    entry.count += 1
    return entry.count <= limit
  }
}

export const RESET_CHECK_LIMIT = 30
export const RESET_CHECK_WINDOW_MS = 60_000

export const resetCheckLimiter = createRateLimiter({ limit: RESET_CHECK_LIMIT, windowMs: RESET_CHECK_WINDOW_MS })

type HeaderReader = { get(name: string): string | null }

/** The client key for the limiter: the first forwarded address, or a shared bucket. */
export function resetCheckClientKey(headers: HeaderReader): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  return headers.get('x-real-ip')?.trim() || 'unknown'
}
