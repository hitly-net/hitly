/**
 * Must-open state for one approval (hitly#96 S10).
 *
 * Host-recorded opens (`GET /api/v1/approvals/:id` → `openedRefs`) are the
 * source of truth. Screen-local taps are merged on top so a just-opened item
 * unlocks immediately without waiting for a reload, and so re-entering an
 * approval does not force opening every item again (or posting duplicate
 * `opened` events).
 */

/** Union of this reviewer's recorded opens and taps from this screen visit. */
export function mergeOpenedRefs(
  recorded: readonly string[] | null | undefined,
  local: readonly string[],
): string[] {
  return Array.from(new Set([...(recorded ?? []), ...local]))
}

/**
 * Whether this tap still needs a `POST /opens`. Skip when the reviewer already
 * has a recorded (or this-visit) open for the ref.
 */
export function shouldRecordOpen(ref: string, openedRefs: readonly string[]): boolean {
  return !openedRefs.includes(ref)
}

/** Append a newly recorded ref; no-op if it is already in the local list. */
export function appendOpenedRef(current: readonly string[], ref: string): string[] {
  return current.includes(ref) ? [...current] : [...current, ref]
}

/**
 * Screen-local opens belong to one approval id. Navigating to a different item
 * drops them so they cannot leak into the next checklist.
 */
export function localOpensForApproval(
  approvalId: string,
  previousApprovalId: string | undefined,
  previousLocal: readonly string[],
): string[] {
  if (previousApprovalId === approvalId) return [...previousLocal]
  return []
}
