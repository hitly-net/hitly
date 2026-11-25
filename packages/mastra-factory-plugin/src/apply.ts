import type { ApplyOutcome, ApprovalSnapshot, Gate } from './types.ts'

export interface ApplyDeps {
  gates: Record<Gate, boolean>
  mergeAfterAccept: boolean
  answerParked(args: {
    sessionId: string
    orgId?: string
    userId?: string
    toolCallId?: string
    decision: 'approve' | 'decline'
    reason: string
  }): Promise<void>
  signalSession(args: { sessionId: string; threadId?: string; message: string }): Promise<void>
  markMergeReady(args: { approvalId: string; prUrl?: string; headSha?: string }): Promise<void>
  attemptMerge(args: { prUrl?: string; headSha?: string }): Promise<{ merged: boolean; reason?: string }>
  recordEvent(eventId: string): Promise<void>
  alreadyApplied(key: string): Promise<boolean>
  markApplied(key: string): Promise<void>
}

const VALID_GATES: readonly Gate[] = ['plan', 'review', 'ask_user']

function identity(snapshot: ApprovalSnapshot): { sessionId: string; threadId?: string; orgId?: string; userId?: string; toolCallId?: string } | null {
  if (!snapshot.sessionId) return null
  return {
    sessionId: snapshot.sessionId,
    threadId: snapshot.threadId,
    orgId: snapshot.orgId,
    userId: snapshot.userId,
    toolCallId: snapshot.toolCallId,
  }
}

function answerParked(deps: ApplyDeps, snapshot: ApprovalSnapshot, decision: 'approve' | 'decline', reason: string): Promise<void> {
  const id = identity(snapshot)!
  return deps.answerParked({
    sessionId: id.sessionId,
    orgId: id.orgId,
    userId: id.userId,
    toolCallId: id.toolCallId,
    decision,
    reason,
  })
}

function signal(deps: ApplyDeps, snapshot: ApprovalSnapshot, message: string): Promise<void> {
  const id = identity(snapshot)!
  return deps.signalSession({ sessionId: id.sessionId, threadId: id.threadId, message })
}

function editedPlanText(snapshot: ApprovalSnapshot): string {
  if (snapshot.editedArgs === undefined) return snapshot.reason ?? '(no edited plan provided)'
  try {
    return JSON.stringify(snapshot.editedArgs, null, 2)
  } catch {
    return String(snapshot.editedArgs)
  }
}

async function dispatchDecided(snapshot: ApprovalSnapshot, deps: ApplyDeps): Promise<ApplyOutcome> {
  const decision = snapshot.decision
  switch (snapshot.gate) {
    case 'plan': {
      if (decision === 'accept') {
        await answerParked(deps, snapshot, 'approve', 'Plan accepted via HITLy')
        return { applied: true }
      }
      if (decision === 'reject') {
        await answerParked(deps, snapshot, 'decline', snapshot.reason ?? 'Plan rejected via HITLy')
        return { applied: true }
      }
      if (decision === 'edit') {
        // Fail-closed: an edit is NEVER auto-approved. The parked call is
        // declined and the edited plan reaches the agent as a session signal,
        // so the agent re-proposes explicitly.
        await answerParked(deps, snapshot, 'decline', `Plan edited by reviewer — resubmit the revised plan. ${snapshot.reason ?? ''}`.trim())
        await signal(deps, snapshot, `Reviewer edited the plan in HITLy. Revised plan (follow it, then resubmit for approval):\n\n${editedPlanText(snapshot)}`)
        return { applied: true }
      }
      return { applied: false, reason: `unsupported decision for plan gate: ${String(decision)}` }
    }
    case 'review': {
      if (decision === 'accept') {
        await deps.markMergeReady({ approvalId: snapshot.id, prUrl: snapshot.prUrl, headSha: snapshot.headSha })
        await signal(deps, snapshot, 'HITLy review: changes ACCEPTED. The change is merge-ready under HITLy merge authority.')
        if (deps.mergeAfterAccept && snapshot.prUrl) {
          const merge = await deps.attemptMerge({ prUrl: snapshot.prUrl, headSha: snapshot.headSha })
          if (!merge.merged) {
            await signal(deps, snapshot, `HITLy review accepted, but auto-merge did not complete: ${merge.reason ?? 'unknown reason'}. A human must merge.`)
          }
        }
        return { applied: true }
      }
      if (decision === 'reject') {
        // Hard rule: a rejected review NEVER triggers a merge under any config.
        await signal(
          deps,
          snapshot,
          `HITLy review: changes REQUESTED. Do not merge. Address these findings and request review again:\n\n${snapshot.reason ?? '(no findings written)'}`,
        )
        return { applied: true }
      }
      return { applied: false, reason: `unsupported decision for review gate: ${String(decision)}` }
    }
    case 'ask_user': {
      if (decision === 'respond') {
        const answer = snapshot.response?.trim()
        if (!answer) return { applied: false, reason: 'response is empty — refusing to deliver a fabricated answer' }
        await signal(deps, snapshot, `HITLy answer to your question: ${answer}`)
        return { applied: true }
      }
      if (decision === 'reject') {
        await signal(
          deps,
          snapshot,
          `The question was declined in HITLy — no answer was given. Reason: ${snapshot.reason ?? '(none)'} Do not invent an answer; proceed without one or re-ask.`,
        )
        return { applied: true }
      }
      return { applied: false, reason: `unsupported decision for ask_user gate: ${String(decision)}` }
    }
  }
}

async function dispatchClosed(snapshot: ApprovalSnapshot, deps: ApplyDeps, statusLabel: string): Promise<ApplyOutcome> {
  switch (snapshot.gate) {
    case 'plan': {
      // Expiry/cancellation is never approval: unblock the session by declining.
      await answerParked(deps, snapshot, 'decline', `HITLy plan approval ${statusLabel} — the plan was NOT approved.`)
      return { applied: true }
    }
    case 'review': {
      await signal(deps, snapshot, `HITLy review approval ${statusLabel} — no verdict was given. Do not merge; request review again.`)
      return { applied: true }
    }
    case 'ask_user': {
      await signal(deps, snapshot, `HITLy question ${statusLabel} — no answer arrived. Do not fabricate an answer; re-ask if still needed.`)
      return { applied: true }
    }
  }
}

/**
 * Apply a HITLy decision (or closure event) to the Factory session.
 *
 * Invariants (contract-tested):
 * - Only HITLy-authoritative decisions drive action: `decided`, or
 *   `failed_resume` whose decision record is non-null (delivery failed, the
 *   human decided). `pending` NEVER counts as approval; `expired`/`cancelled`
 *   drive closure only.
 * - A review reject never merges, under any config. Merge only after an
 *   explicit accept AND mergeAfterAccept.
 * - An empty answer is never delivered; nothing is ever invented.
 * - Idempotent per (approvalId, decision-or-closure).
 */
export async function applyDecision(snapshot: ApprovalSnapshot, deps: ApplyDeps): Promise<ApplyOutcome> {
  if (!VALID_GATES.includes(snapshot.gate)) {
    return { applied: false, reason: `unknown gate: ${String(snapshot.gate)}` }
  }
  if (!snapshot.sessionId) {
    return { applied: false, reason: 'missing session identity — refusing to act' }
  }
  if (snapshot.status === 'pending') {
    return { applied: false, reason: 'status pending does not authorize any action' }
  }
  if (snapshot.status === 'failed_resume' && snapshot.decision === null) {
    // Delivery failed before HITLy recorded a decision — nothing to converge to.
    return { applied: false, reason: 'failed_resume without a decision does not authorize any action' }
  }
  if (snapshot.decision === 'ignore' || snapshot.decision === 'cancel') {
    // Acknowledged no-op: the session keeps running untouched; the HITLy
    // request is already closed on the HITLy side.
    return { applied: false, reason: `decision ${snapshot.decision} is an acknowledged no-op` }
  }

  const key = `${snapshot.id}:${snapshot.decision ?? snapshot.status}`
  if (await deps.alreadyApplied(key)) {
    return { applied: false, reason: 'decision already applied for this approval' }
  }

  // A `failed_resume` row carries a real human decision whose callback
  // delivery exhausted its retries (~1s of attempts). The authority read
  // joins the decision record, so it is as safe to converge as `decided` —
  // and shares its idempotency key, so a later manual Retry-Resume dedupes.
  const outcome =
    snapshot.status === 'decided' || (snapshot.status === 'failed_resume' && snapshot.decision !== null)
      ? await dispatchDecided(snapshot, deps)
      : await dispatchClosed(snapshot, deps, snapshot.status === 'expired' ? 'expired' : 'was cancelled')

  if (outcome.applied) {
    await deps.markApplied(key)
  }
  return outcome
}
