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
 * - respond          -> answered, value = the reviewer's reply text
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
    switch (decision.decision) {
      case 'accept':
      case 'reject':
      case 'edit':
      case 'respond': {
        let value: string
        if (decision.decision === 'reject') value = 'reject'
        else if (decision.decision === 'respond') value = typeof payload.response === 'string' ? payload.response : ''
        else value = 'approve'
        if (decision.decision === 'edit' && payload.editedArgs && typeof payload.editedArgs === 'object') {
          const raw = payload.editedArgs as Record<string, unknown>
          editedArgs = input.mergeEdits?.(raw) ?? { ...originalArgs, ...raw }
          meta['net.hitly/editedArgs'] = editedArgs
          meta['net.hitly/editedArgsHash'] = await jcsHash(editedArgs)
        }
        hitl = {
          ...base,
          status: 'answered',
          value,
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
