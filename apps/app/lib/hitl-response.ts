import { argsHash as computeArgsHash, contextItems, jcsHash, type ApprovalEnvelope, type Decision } from '@hitly/core'

/**
 * Builds the hitl/response/v0 view of a request for requester (API-key) reads
 * (hitl-spec section 4). Pure: the caller loads the rows.
 *
 * Mapping from HITLy decisions:
 * - accept           -> answered, value "approve"
 * - edit             -> answered, value "approve"; the approver's amended
 *                       arguments travel only in the response
 *                       (`_meta["net.hitly/editedArgs"]`, full merged args).
 *                       The stored request and `argsHash` stay the original.
 * - reject           -> answered, value "reject"
 * - respond          -> answered; when the host holds a typed ask_user answer
 *                       that answer is the ONLY carrier (top-level `answer`,
 *                       hitl-spec 4.2 PM ruling) and `value` is OMITTED;
 *                       without a typed answer, `value` = the reviewer's reply
 *                       text, and a respond with no reply text OMITS `value`
 *                       (never `value: ""`), matching MCP get_decision
 * - ignore           -> declined (no value)
 * - cancel           -> cancelled (`_meta["net.hitly/cancelledBy"]` says whether
 *                       the requester or a reviewer withdrew it)
 * - expired          -> expired
 * Open requests (`pending`, `failed_resume` without a decision) have no
 * response yet: `hitl` is null and `state` says where the request is.
 * `signature` is null (response signing is v2).
 */

export type HitlDecidedBy = { kind: 'human' | 'group' | 'service'; id: string; display?: string }

export type HitlActivity = {
  presentedAt: string | null
  items: Array<{ ref: string; sha256: string | null; openedAt: string[] }>
}

export type HitlResponseV0 = {
  spec: 'hitl/response/v0'
  requestId: string
  status: 'answered' | 'declined' | 'cancelled' | 'expired'
  value?: string
  reason?: string
  decidedBy?: HitlDecidedBy
  decidedAt?: string
  argsHash: string
  signature: null
  activity: HitlActivity
  /**
   * The reviewer's typed ask_user answer (hitl-spec 7), verbatim from the
   * stored decision payload, at the SAME place and shape MCP get_decision
   * returns it (top level of the hitl/response/v0 view). Present exactly when
   * the host holds a typed answer; when none, this key is simply ABSENT -
   * never `answer: null` (a stored literal null is treated as absent).
   */
  answer?: unknown
  /**
   * Extension namespace (hitl-spec section 12).
   *
   * @deprecated key `net.hitly/answer` is a deprecated HITLy vendor alias kept
   * for backward compatibility. It carries exactly the same value as top-level
   * `answer` and is omitted whenever `answer` is. Top-level `answer` is the
   * authoritative field; hosts and clients SHOULD NOT rely on the alias.
   */
  _meta?: Record<string, unknown>
}

export type DecisionRow = {
  decision: Decision
  payload: Record<string, unknown>
  actorUserId: string | null
  createdAt: Date
}

export type OpenEventRow = { itemRef: string; openedAt: string }

export type HitlReadInput = {
  approval: { id: string; status: string; presentedAt: Date | null; expiresAt: Date | null; createdAt: Date }
  envelope: ApprovalEnvelope
  /** Latest decision record, if any. */
  decision: DecisionRow | null
  opens: OpenEventRow[]
  /** Clock for the lazy-expiry check (tests). */
  now?: number
  /** Merges the approver's edits into the original args (lib/approvals.ts mergeEditableArgs). */
  mergeEdits?: (edited: Record<string, unknown>) => Record<string, unknown> | null
}

export function buildActivity(envelope: ApprovalEnvelope, presentedAt: Date | null, opens: OpenEventRow[]): HitlActivity {
  const byRef = new Map<string, string[]>()
  for (const open of opens) {
    const list = byRef.get(open.itemRef) ?? []
    list.push(open.openedAt)
    byRef.set(open.itemRef, list)
  }
  const seen = new Set<string>()
  const items: HitlActivity['items'] = []
  for (const item of contextItems(envelope)) {
    if (seen.has(item.ref)) continue
    seen.add(item.ref)
    // HITLy attachments carry no content hash yet, so sha256 is null for every item.
    items.push({ ref: item.ref, sha256: null, openedAt: [...(byRef.get(item.ref) ?? [])].sort() })
  }
  return { presentedAt: presentedAt ? presentedAt.toISOString() : null, items }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export async function buildHitlRead(input: HitlReadInput) {
  const now = input.now ?? Date.now()
  const { approval, envelope, decision } = input
  const originalArgs = (envelope.action?.args ?? {}) as Record<string, unknown>
  const argsHash = await computeArgsHash(originalArgs)
  const activity = buildActivity(envelope, approval.presentedAt, input.opens)

  const lazilyExpired =
    approval.status === 'pending' && approval.expiresAt != null && approval.expiresAt.getTime() < now
  const state = lazilyExpired ? 'expired' : approval.status

  const base = { spec: 'hitl/response/v0' as const, requestId: approval.id, argsHash, signature: null, activity }
  let hitl: HitlResponseV0 | null = null
  let editedArgs: Record<string, unknown> | undefined

  if (decision) {
    const payload = decision.payload ?? {}
    const reason = nonEmpty(payload.reason)
    const decidedBy: HitlDecidedBy | undefined = decision.actorUserId ? { kind: 'human', id: decision.actorUserId } : undefined
    const decidedAt = decision.createdAt.toISOString()
    const meta: Record<string, unknown> = { 'net.hitly/decision': decision.decision }
    // Typed ask_user answer (hitl-spec 7): a first-class top-level `answer` on
    // the hitl/response/v0 view - the same place and shape MCP get_decision
    // returns it. Never invented; when absent the key is OMITTED, never
    // `answer: null` (a stored literal null is treated as absent). The stored
    // request and decision payload are never mutated.
    const answer: unknown = payload.answer !== undefined && payload.answer !== null ? payload.answer : undefined
    if (answer !== undefined) {
      // @deprecated HITLy vendor alias (section-12 extension namespace) kept
      // for backward compatibility only: it carries exactly the same value as
      // top-level `answer` and is omitted whenever `answer` is omitted.
      // Top-level `answer` is authoritative; hosts and clients SHOULD NOT
      // rely on this key.
      meta['net.hitly/answer'] = answer
    }
    switch (decision.decision) {
      case 'accept':
      case 'reject':
      case 'edit':
      case 'respond': {
        // PM ruling on hitl-spec 4.2 (Test M1): when the host holds a typed
        // answer, top-level `answer` is the ONLY carrier of the answer and
        // `value` MUST NOT be present alongside it - on REST and MCP alike.
        // Without a typed answer, respond with no reply text OMITS `value`
        // (never `value: ""`), matching MCP toResponseV0, which maps respond
        // value only from a string `response` and leaves the key out otherwise.
        let value: string | undefined
        if (answer === undefined) {
          if (decision.decision === 'reject') value = 'reject'
          else if (decision.decision === 'respond') value = typeof payload.response === 'string' ? payload.response : undefined
          else value = 'approve'
        }
        if (decision.decision === 'edit' && payload.editedArgs && typeof payload.editedArgs === 'object') {
          const raw = payload.editedArgs as Record<string, unknown>
          editedArgs = input.mergeEdits?.(raw) ?? { ...originalArgs, ...raw }
          meta['net.hitly/editedArgs'] = editedArgs
          meta['net.hitly/editedArgsHash'] = await jcsHash(editedArgs)
        }
        hitl = {
          ...base,
          status: 'answered',
          ...(value !== undefined ? { value } : {}),
          ...(reason ? { reason } : {}),
          ...(decidedBy ? { decidedBy } : {}),
          decidedAt,
          _meta: meta,
        }
        break
      }
      case 'ignore':
        hitl = {
          ...base,
          status: 'declined',
          ...(reason ? { reason } : {}),
          ...(decidedBy ? { decidedBy } : {}),
          decidedAt,
          _meta: meta,
        }
        break
      case 'cancel':
        hitl = {
          ...base,
          status: 'cancelled',
          ...(reason ? { reason } : {}),
          _meta: { ...meta, 'net.hitly/cancelledBy': payload.by === 'requester' ? 'requester' : 'reviewer', 'net.hitly/cancelledAt': decidedAt },
        }
        break
    }
    // First-class top-level `answer` on the hitl/response/v0 view, at the same
    // place and shape MCP get_decision returns it (see toResponseV0). Omitted
    // when there is no typed answer - never `answer: null`. The deprecated
    // _meta["net.hitly/answer"] alias above always mirrors this value exactly.
    if (hitl && answer !== undefined) hitl.answer = answer
    // spec 4.2: answered and declined need decidedBy; a decision whose reviewer
    // account was deleted (actor set null) is reported as a service decision.
    if (hitl && (hitl.status === 'answered' || hitl.status === 'declined') && !hitl.decidedBy) {
      hitl.decidedBy = { kind: 'service', id: 'hitly:deleted-user' }
    }
  } else if (state === 'expired') {
    hitl = { ...base, status: 'expired' }
  } else if (state === 'cancelled') {
    hitl = { ...base, status: 'cancelled' }
  }

  return { state, argsHash, activity, hitl, ...(editedArgs ? { editedArgs } : {}) }
}
