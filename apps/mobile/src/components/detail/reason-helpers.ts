import type { Decision } from '@hitly/core'

/**
 * Reason-sheet state for one decide (hitly#96 S11 / mobile S5).
 *
 * The typed reason stays in this object until decide succeeds. A refused or
 * failed submit must not wipe it — spec §7 asks the client to keep the
 * reviewer's input.
 */

export type ReasonFlow<Extra extends object = object> = {
  decision: Decision
  extra?: Extra
  /** Reviewer's typed reason, stored as typed (trim only for the emptiness check). */
  reason: string
}

export function canSubmitReason(reason: string): boolean {
  return reason.trim().length > 0
}

/**
 * Open (or reuse) the reason sheet for a decision. Re-gating the same decision
 * keeps the typed reason so a second tap on the answer button cannot wipe it.
 */
export function openReasonFlow<Extra extends object>(
  current: ReasonFlow<Extra> | null,
  decision: Decision,
  extra?: Extra,
): ReasonFlow<Extra> {
  if (current && current.decision === decision) {
    return { ...current, extra: extra ?? current.extra }
  }
  return { decision, extra, reason: '' }
}

/**
 * Build the decide payload from the open sheet. Returns null when the reason is
 * blank after trim. Does not clear the flow — the caller keeps it until
 * `reasonFlowAfterDecide` sees success.
 */
export function reasonDecidePayload<Extra extends object>(
  flow: ReasonFlow<Extra>,
): { decision: Decision; extra: Extra & { reason: string } } | null {
  if (!canSubmitReason(flow.reason)) return null
  return {
    decision: flow.decision,
    extra: { ...(flow.extra ?? ({} as Extra)), reason: flow.reason },
  }
}

/** Success dismisses the sheet. Failure keeps the typed reason on screen. */
export function reasonFlowAfterDecide<Extra extends object>(
  flow: ReasonFlow<Extra> | null,
  result: 'success' | 'failure',
): ReasonFlow<Extra> | null {
  if (result === 'success') return null
  return flow
}
