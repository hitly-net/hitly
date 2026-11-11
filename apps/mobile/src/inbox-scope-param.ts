import { isInboxScope, type InboxScope } from './components/inbox/InboxScopeTabs.types'

/**
 * The home "Failed resume" card links into the inbox with an explicit scope
 * hint. The inbox tab defaults to `open`, and decided-but-undelivered
 * `failed_resume` rows are NOT open statuses - so the card must land on
 * `all`, or tapping it shows an empty list (soft S1 on the pending-lists
 * fix).
 */
export const FAILED_RESUME_INBOX_SCOPE: InboxScope = 'all'

/**
 * Validate a `scope` route param (expo-router can hand back a string or an
 * array for repeated params). Anything unknown falls back to the screen's
 * own default - a tampered or stale param must never select a bogus scope.
 */
export function inboxScopeFromParam(raw: string | string[] | undefined): InboxScope | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  return isInboxScope(value) ? value : undefined
}
