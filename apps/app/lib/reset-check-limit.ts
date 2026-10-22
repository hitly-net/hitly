/**
 * A small in-memory limiter for the reset page's link check. The page calls
 * Better Auth in process, which skips Better Auth's own request limiter, so
 * this keeps the page from answering an unlimited number of checks for one
 * client. When a client is over the limit the page shows the "couldn't check
 * this link right now" state instead of the form.
 *
 * The limit is per server process. It never stores or logs the token.
 */

import { clientAddress } from './client-address'

export type RateLimiter = ((key: string) => boolean) & {
  /** Number of client keys currently held (for tests and diagnostics). */
  size: () => number
}

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
  // Every window has the same length and a key is moved to the end whenever
  // its window starts, so the map stays ordered by expiry: oldest first.
  const windows = new Map<string, { count: number; resetAt: number }>()

  const makeRoom = (time: number) => {
    // Drop expired windows first, then the oldest live ones. Other clients'
    // counters are kept, so a flood of new keys can't reset everyone.
    for (const [key, entry] of windows) {
      if (windows.size < maxKeys) return
      if (entry.resetAt > time) break
      windows.delete(key)
    }
    for (const key of windows.keys()) {
      if (windows.size < maxKeys) return
      windows.delete(key)
    }
  }

  const allow = (key: string) => {
    const time = now()
    let entry = windows.get(key)
    if (!entry || entry.resetAt <= time) {
      windows.delete(key)
      makeRoom(time)
      entry = { count: 0, resetAt: time + windowMs }
      windows.set(key, entry)
    }
    entry.count += 1
    return entry.count <= limit
  }
  return Object.assign(allow, { size: () => windows.size })
}

export const RESET_CHECK_LIMIT = 30
export const RESET_CHECK_WINDOW_MS = 60_000

export const resetCheckLimiter = createRateLimiter({ limit: RESET_CHECK_LIMIT, windowMs: RESET_CHECK_WINDOW_MS })

type HeaderReader = { get(name: string): string | null }

/**
 * The client key for the limiter: the client address picked with the trusted
 * proxy count (see client-address.ts), or one shared bucket when there is none.
 */
export function resetCheckClientKey(
  headers: HeaderReader,
  options?: { trustedProxies?: number; remoteAddress?: string | null },
): string {
  return clientAddress(headers, options) ?? 'unknown'
}
