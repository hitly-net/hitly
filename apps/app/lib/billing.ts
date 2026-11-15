/**
 * App-side wrapper for the edition billing hook (edition.billing).
 *
 * OSS ships a never-paid stub; the Cloud overlay answers from its own
 * billing tables. Every call is fail-closed against destructive use: a
 * missing seam or a throwing implementation is reported as "a paid
 * subscription exists" (so workspace deletion answers 409 instead of
 * destroying a paying tenant's data) and as "the plan just changed" (so a
 * retention sweep keeps data longer instead of deleting it). Log lines are
 * value-free — no customer data in logs.
 */
import { edition } from '@hitly/cloud'

const LOG_PREFIX = '[hitly billing]'

export async function hasActivePaidSubscription(workspaceId: string): Promise<boolean> {
  if (!edition.billing) return false
  try {
    return await edition.billing.hasActivePaidSubscription(workspaceId)
  } catch {
    console.warn(`${LOG_PREFIX} hasActivePaidSubscription failed; assuming an active subscription`)
    return true
  }
}

export async function getPlanChangedAt(workspaceId: string): Promise<Date | null> {
  if (!edition.billing) return null
  try {
    return await edition.billing.getPlanChangedAt(workspaceId)
  } catch {
    // Fail-safe for a retention sweep: pretend the plan just changed so
    // nothing closed recently (or before the unknown change) is deleted.
    console.warn(`${LOG_PREFIX} getPlanChangedAt failed; protecting retention window`)
    return new Date()
  }
}
