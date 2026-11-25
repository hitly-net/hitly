import { METADATA_KEYS } from './gates.ts'
import type { ApprovalSnapshot, Gate } from './types.ts'

const VALID_GATES: readonly Gate[] = ['plan', 'review', 'ask_user']

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
  log?(level: string, message: string, meta?: Record<string, unknown>): void
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * Backstop reconciliation between HITLy (authority) and the Factory session.
 *
 * HITLy pushes decisions to the resume route; this poller guarantees the
 * session still converges when a callback is lost (Factory restart, network
 * partition, exhausted retries). It only READS authoritative state and feeds
 * it through the same applyDecision matrix as the callback path — the poller
 * itself decides nothing, so expiry/pending can never be turned into
 * approval here either.
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

      if (state.status === 'pending' || state.status === 'failed_resume') {
        // Still awaiting a human (or a retry HITLy owns). Nothing to do.
        continue
      }

      const snapshot = this.snapshot(entry, state, gate)
      try {
        const outcome = await this.deps.apply(snapshot)
        if (outcome.applied) applied += 1
        this.deps.closeOpen(entry.approvalId)
      } catch (error) {
        errors += 1
        this.deps.log?.('error', 'hitly reconcile: apply failed, will retry', {
          approvalId: entry.approvalId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { checked, applied, errors, configRefreshed }
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
