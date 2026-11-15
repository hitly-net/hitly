/**
 * Housekeeping for account-security events.
 *
 * Account deletion keeps a user's security events for a retention window
 * (HITLY_SECURITY_EVENT_RETENTION_DAYS, default 90) with the user id and email
 * replaced by HMACs and the client address truncated to its block. This sweep
 * is what makes that "keep" temporary: only rows that are BOTH anonymised
 * (`user_id IS NULL`) and past their own `retention_expires_at` are deleted,
 * so a live user's events — which always carry a user id — can never be swept,
 * and a row that was never anonymised (no deadline) is never swept either.
 */

import { and, inArray, isNull, lt } from 'drizzle-orm'
import { accountSecurityEvents } from '@hitly/db/schema'
import { requireDb } from '../require-db'
import { affectedRows } from './result'
import { registerHousekeepingJob } from './scheduler'

const DELETE_CHUNK = 500

export async function purgeExpiredSecurityEvents(options: { now?: () => number } = {}) {
  const database = requireDb()
  const nowMs = options.now?.() ?? Date.now()
  const deadline = new Date(nowMs)
  const guard = () => and(isNull(accountSecurityEvents.userId), lt(accountSecurityEvents.retentionExpiresAt, deadline))
  let deleted = 0
  for (;;) {
    const stale = await database
      .select({ id: accountSecurityEvents.id })
      .from(accountSecurityEvents)
      .where(guard())
      .limit(DELETE_CHUNK)
    if (stale.length === 0) break
    const ids = stale.map((row) => row.id)
    // Delete the SELECTed ids under the same guard, so a row that gained a
    // user id (or a later deadline) between the two statements is not swept.
    const result = await database
      .delete(accountSecurityEvents)
      .where(and(inArray(accountSecurityEvents.id, ids), guard()))
    const removed = affectedRows(result)
    deleted += removed
    // Nothing deleted although rows matched: another writer moved them out of
    // the sweep. Stop instead of spinning on the same SELECT.
    if (removed === 0) break
  }
  return { deleted }
}

export function registerSecurityEventsHousekeepingJob() {
  registerHousekeepingJob({
    id: 'purge-expired-security-events',
    schedule: 'daily',
    run: purgeExpiredSecurityEvents,
  })
}
