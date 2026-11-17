/**
 * Limit for the "Request my data" endpoint. Creating a request is
 * idempotent (an already-open request is returned, not duplicated), so the
 * limit exists only to keep a client from hammering the database: past the
 * limit the route answers 429 + Retry-After without touching the database.
 * In-process calls skip Better Auth's request limiter, so this uses the
 * shared factory (lib/reset-check-limit.ts). The bucket is keyed on the
 * user id, matching every other account-scoped limit.
 */

import { createRateLimiter, type RateLimiter } from './reset-check-limit'

export const DATA_REQUEST_LIMIT = 10
export const DATA_REQUEST_WINDOW_MS = 60 * 60 * 1000
export const DATA_REQUEST_LIMITED_LOG =
  '[hitly data-request] Data request refused: too many requests from this account.'

/** Seconds a rejected request must wait before retrying (Retry-After header). */
export const DATA_REQUEST_RETRY_AFTER_SECONDS = Math.ceil(DATA_REQUEST_WINDOW_MS / 1000)

export function createDataRequestLimiter(options: { now?: () => number } = {}): RateLimiter {
  return createRateLimiter({
    limit: DATA_REQUEST_LIMIT,
    windowMs: DATA_REQUEST_WINDOW_MS,
    ...options,
  })
}

export const dataRequestLimiter = createDataRequestLimiter()
