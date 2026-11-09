/**
 * Per-API-key rate limiting (PM ruling, M1): a fixed sliding window per caller.
 * The server answers 429 with Retry-After once a key exceeds its budget inside the
 * window. limit <= 0 disables. Buckets expire with the window so the map cannot grow
 * without bound.
 */

export type ConsumeResult = { ok: true } | { ok: false; retryAfterMs: number }

export interface RateLimiter {
  tryConsume(id: string): ConsumeResult
}

export function createRateLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
): RateLimiter {
  const buckets = new Map<string, { count: number; windowStart: number }>()
  let lastSweep = 0

  return {
    tryConsume(id: string): ConsumeResult {
      if (limit <= 0 || windowMs <= 0) return { ok: true }
      const at = now()
      if (buckets.size > 1024 && at - lastSweep > windowMs) {
        lastSweep = at
        for (const [key, bucket] of buckets) {
          if (at >= bucket.windowStart + windowMs) buckets.delete(key)
        }
      }
      const bucket = buckets.get(id)
      if (!bucket || at >= bucket.windowStart + windowMs) {
        buckets.set(id, { count: 1, windowStart: at })
        return { ok: true }
      }
      if (bucket.count >= limit) {
        return { ok: false, retryAfterMs: bucket.windowStart + windowMs - at }
      }
      bucket.count += 1
      return { ok: true }
    },
  }
}
