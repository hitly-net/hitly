import { METADATA_KEYS } from './gates.ts'
import type { ApprovalSnapshot, Gate } from './types.ts'

const VALID_GATES: readonly Gate[] = ['plan', 'review', 'ask_user']

/**
 * answerParkedCall throws this when the parked call is already answered (or
 * its run ended) — see @mastra/factory approval-tools. On the reconciler
 * path it means "already delivered", not "failed".
 */
const NOTHING_WAITING_ON_TOOL_CALL = /nothing is waiting on that tool call/i

export interface OpenApproval {
  approvalId: string
  gate: Gate
  metadata: Record<string, unknown>
}

export interface ReconcilerApprovalState {
  id: string
  status: string
  decision: string | null
  metadata: Record<string, unknown>
  reason?: string
  editedArgs?: Record<string, unknown>
  response?: string
  answer?: string
}

export interface ReconcilerDeps {
  listOpen(): OpenApproval[]
  closeOpen(approvalId: string): void
  getApproval(approvalId: string): Promise<ReconcilerApprovalState>
  refreshConfig?(): Promise<void>
  apply(snapshot: ApprovalSnapshot): Promise<{ applied: boolean; reason?: string }>
  /** Host receipt that settled a converged failed_resume row on HITLy (optional; best-effort). */
  ackResume?(approvalId: string): Promise<void>
  log?(level: string, message: string, meta?: Record<string, unknown>): void
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * Backstop reconciliation between HITLy (authority) and the Factory session.
 *
 * HITLy pushes decisions to the resume route, but its callback retries last
 * about a second — a Factory restart outlives them and the row lands in
 * `failed_resume` with the human decision recorded. This poller guarantees
 * the session still converges when a callback is lost (Factory restart,
 * network partition, exhausted retries), including those `failed_resume`
 * rows. It only READS authoritative state and feeds it through the same
 * applyDecision matrix as the callback path — the poller itself decides
 * nothing, so expiry/pending can never be turned into approval here either.
 * After converging a `failed_resume` decision it POSTs a resume-ack receipt
 * so the row settles to `decided` and stops replaying on every restart.
 */
export class HitlyReconciler {
  private readonly deps: ReconcilerDeps

  constructor(deps: ReconcilerDeps) {
    this.deps = deps
  }

  async tick(): Promise<{ checked: number; applied: number; errors: number; configRefreshed: boolean }> {
    let configRefreshed = false
    if (this.deps.refreshConfig) {
      try {
        await this.deps.refreshConfig()
        configRefreshed = true
      } catch (error) {
        // Fail-closed: keep the last-known gate state; never merge or apply
        // differently because HITLy was momentarily unreachable.
        this.deps.log?.('warn', 'hitly reconcile: config refresh failed, keeping current gates', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    let checked = 0
    let applied = 0
    let errors = 0
    for (const entry of this.deps.listOpen()) {
      checked += 1
      let state: ReconcilerApprovalState
      try {
        state = await this.deps.getApproval(entry.approvalId)
      } catch (error) {
        errors += 1
        this.deps.log?.('warn', 'hitly reconcile: approval read failed, will retry', {
          approvalId: entry.approvalId,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }

      const gate = VALID_GATES.includes(state.metadata[METADATA_KEYS.gate] as Gate)
        ? (state.metadata[METADATA_KEYS.gate] as Gate)
        : VALID_GATES.includes(entry.gate)
          ? entry.gate
          : null
      if (!gate) {
        this.deps.log?.('warn', 'hitly reconcile: unknown gate, dropping', { approvalId: entry.approvalId })
        this.deps.closeOpen(entry.approvalId)
        continue
      }

      if (state.status === 'pending') {
        // Still awaiting a human. Nothing to do; stay open for the next tick.
        continue
      }
      if (state.status === 'failed_resume' && state.decision === null) {
        // Delivery failed before HITLy recorded a decision, and HITLy does
        // not auto-retry failed_resume — stay open so a late decision (or a
        // manual Retry-Resume that records one) still converges.
        continue
      }

      const snapshot = this.snapshot(entry, state, gate)
      const settle = state.status === 'failed_resume' && state.decision !== null
      try {
        const outcome = await this.deps.apply(snapshot)
        if (outcome.applied) applied += 1
        await this.settleOnHitly(entry.approvalId, settle)
        this.deps.closeOpen(entry.approvalId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (NOTHING_WAITING_ON_TOOL_CALL.test(message)) {
          // Replay against an already-answered parked call — the "lost"
          // callback actually landed, or a previous process converged it.
          // The decision is fully delivered: count it, settle the HITLy row,
          // and stop replaying (otherwise a plan gate errors every tick).
          applied += 1
          await this.settleOnHitly(entry.approvalId, settle)
          this.deps.closeOpen(entry.approvalId)
          continue
        }
        errors += 1
        this.deps.log?.('error', 'hitly reconcile: apply failed, will retry', {
          approvalId: entry.approvalId,
          error: message,
        })
      }
    }
    return { checked, applied, errors, configRefreshed }
  }

  /**
   * Tell HITLy a failed_resume decision was converged so the row settles to
   * `decided` and leaves the restart feed. Best-effort: a lost ack only means
   * a future restart replays the apply, which is idempotent and tolerated.
   */
  private async settleOnHitly(approvalId: string, needed: boolean): Promise<void> {
    if (!needed || !this.deps.ackResume) return
    try {
      await this.deps.ackResume(approvalId)
    } catch (error) {
      this.deps.log?.('warn', 'hitly reconcile: resume-ack failed; row stays open on HITLy', {
        approvalId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private snapshot(entry: OpenApproval, state: ReconcilerApprovalState, gate: Gate): ApprovalSnapshot {
    // HITLy is the authority: its metadata wins over what we stored locally.
    const metadata = { ...entry.metadata, ...state.metadata }
    const snapshot: ApprovalSnapshot = {
      id: entry.approvalId,
      status: state.status as ApprovalSnapshot['status'],
      decision: state.decision,
      gate,
      metadata,
    }
    const sessionId = optionalString(metadata[METADATA_KEYS.sessionId])
    if (sessionId) snapshot.sessionId = sessionId
    const threadId = optionalString(metadata[METADATA_KEYS.threadId])
    if (threadId) snapshot.threadId = threadId
    const toolCallId = optionalString(metadata[METADATA_KEYS.toolCallId])
    if (toolCallId) snapshot.toolCallId = toolCallId
    const orgId = optionalString(metadata[METADATA_KEYS.orgId])
    if (orgId) snapshot.orgId = orgId
    const userId = optionalString(metadata[METADATA_KEYS.userId])
    if (userId) snapshot.userId = userId
    const factoryProjectId = optionalString(metadata[METADATA_KEYS.projectId])
    if (factoryProjectId) snapshot.factoryProjectId = factoryProjectId
    const headSha = optionalString(metadata[METADATA_KEYS.headSha])
    if (headSha) snapshot.headSha = headSha
    const prUrl = optionalString(metadata[METADATA_KEYS.prUrl])
    if (prUrl) snapshot.prUrl = prUrl
    const reason = state.reason ?? optionalString(metadata['reason'])
    if (reason) snapshot.reason = reason
    if (state.editedArgs) snapshot.editedArgs = state.editedArgs
    const response = state.response ?? state.answer ?? optionalString(metadata['response'])
    if (response) snapshot.response = response
    return snapshot
  }
}
