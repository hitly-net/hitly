/**
 * Limit for the GDPR data export endpoint: one full account export per user
 * per hour. In-process calls skip Better Auth's request limiter, so this
 * uses the shared factory (lib/reset-check-limit.ts). The bucket is keyed on
 * the user id (not the client address) because the export reads the whole
 * account. Nothing here stores the exported data.
 */

import { createRateLimiter, type RateLimiter } from './reset-check-limit'

export const EXPORT_LIMIT = 1
export const EXPORT_WINDOW_MS = 60 * 60 * 1000
export const EXPORT_LIMITED_LOG =
  '[hitly gdpr-export] Data export refused: too many exports from this account.'

/** Seconds a rejected export must wait before retrying (Retry-After header). */
export const EXPORT_RETRY_AFTER_SECONDS = Math.ceil(EXPORT_WINDOW_MS / 1000)

export function createExportLimiter(options: { now?: () => number } = {}): RateLimiter {
  return createRateLimiter({ limit: EXPORT_LIMIT, windowMs: EXPORT_WINDOW_MS, ...options })
}

export const exportLimiter = createExportLimiter()
