import { METADATA_KEYS } from './gates.ts'
import {
  closeGateAsDecidedElsewhere,
  gateStateKey,
  type GateRecord,
  type GateStateStore,
} from './gate-state.ts'
import type { ApplyOutcome, ApprovalSnapshot, Gate } from './types.ts'

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
  apply(snapshot: ApprovalSnapshot): Promise<ApplyOutcome>
  /** Host receipt that settled a converged failed_resume row on HITLy (optional; best-effort). */
  ackResume?(approvalId: string): Promise<void>
  /** Per-gate memory. Without it the reconciler cannot tell a lost callback from a Factory-side decision. */
  gateStore?: GateStateStore
  /** Requester cancel: retries a Factory-side close that did not reach HITLy. */
  cancelApproval?(approvalId: string, reason?: string): Promise<void>
  annotateApproval?(approvalId: string, note: string): Promise<{ recorded: boolean }>
  log?(level: string, message: string, meta?: Record<string, unknown>): void
}

function metaValue(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key]
  return typeof value === 'string' && value ? value : undefined
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
 *
 * It also finishes Factory-side closes: a gate the Factory surface answered
 * (recorded in the gate store) is never converged from HITLy state — the
 * reconciler retries the requester cancel that closes the HITLy item and, if
 * HITLy turns out to have decided in the meantime, reports a conflict instead
 * of silently counting the decision as delivered.
 */
export class HitlyReconciler {
  private readonly deps: ReconcilerDeps

  constructor(deps: ReconcilerDeps) {
    this.deps = deps
  }

  async tick(): Promise<{
    checked: number
    applied: number
    errors: number
    conflicts: number
    configRefreshed: boolean
  }> {
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
    let conflicts = 0
    for (const entry of this.deps.listOpen()) {
      checked += 1
      const record = await this.loadRecord(entry)
      if (record?.status === 'factory_resolved' || record?.status === 'conflict') {
        // The Factory answered this tool call. There is no HITLy decision to
        // converge: finish closing the item instead, and never feed HITLy
        // state into the apply matrix for this gate again.
        const { settled, conflict } = await this.convergeFactoryResolved(entry, record)
        if (conflict) conflicts += 1
        if (settled) this.deps.closeOpen(entry.approvalId)
        continue
      }
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
        if (outcome.conflict) {
          conflicts += 1
        } else if (outcome.applied) {
          applied += 1
        }
        await this.settleOnHitly(entry.approvalId, settle)
        this.deps.closeOpen(entry.approvalId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (NOTHING_WAITING_ON_TOOL_CALL.test(message)) {
          // The parked call is already answered. WHAT answered it decides
          // whether that is a converged delivery or a conflict — deciding
          // silently here is exactly how a Factory-side approval used to
          // swallow a HITLy decision. A `factory_resolved` record never
          // reaches this branch: it is converged above, before the apply.
          if (record && record.status === 'open') {
            // Nobody recorded a Factory-side decision, yet nothing is parked:
            // the gate was answered outside this plugin's view (typically a
            // Factory restart between the answer and the observer call).
            conflicts += 1
            await this.persistConflict(entry, record, snapshot.decision ?? snapshot.status, message, 'an unobserved surface')
          } else {
            // No gate record (a row predating gate memory) whose parked call
            // is answered: the "lost" callback actually landed, or a previous
            // process converged it. The decision is fully delivered: count it,
            // settle the HITLy row, and stop replaying.
            applied += 1
            this.deps.log?.('info', 'hitly reconcile: decision was already delivered', {
              approvalId: entry.approvalId,
            })
          }
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
    return { checked, applied, errors, conflicts, configRefreshed }
  }

  private async loadRecord(entry: OpenApproval): Promise<GateRecord | null> {
    if (!this.deps.gateStore) return null
    const sessionId = metaValue(entry.metadata, METADATA_KEYS.sessionId)
    if (!sessionId) return null
    const toolCallId = metaValue(entry.metadata, METADATA_KEYS.toolCallId)
    try {
      return await this.deps.gateStore.load(gateStateKey(sessionId, toolCallId, entry.gate))
    } catch (error) {
      this.deps.log?.('warn', 'hitly reconcile: gate state read failed', {
        approvalId: entry.approvalId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * Finish the work the observer started for a Factory-resolved gate: retry a
   * requester cancel that never reached HITLy, then stop tracking the item.
   * Returns whether the open entry can be dropped.
   */
  private async convergeFactoryResolved(
    entry: OpenApproval,
    record: GateRecord,
  ): Promise<{ settled: boolean; conflict: boolean }> {
    if (record.status === 'conflict') {
      this.deps.log?.('warn', 'hitly reconcile: gate conflict already recorded, dropping', {
        approvalId: entry.approvalId,
        gate: entry.gate,
        hitlyDecision: record.hitlyDecision,
        factoryDecision: record.factoryDecision,
      })
      return { settled: true, conflict: false }
    }
    if (record.cancelledAt) return { settled: true, conflict: false }
    if (!this.deps.cancelApproval || !record.approvalId) {
      this.deps.log?.('warn', 'hitly reconcile: no cancel path for Factory-decided gate; leaving it to a human', {
        approvalId: entry.approvalId,
        gate: entry.gate,
      })
      return { settled: true, conflict: false }
    }
    const outcome = await closeGateAsDecidedElsewhere(record, {
      cancelApproval: (approvalId, reason) => this.deps.cancelApproval!(approvalId, reason),
      getApproval: this.deps.getApproval ? (approvalId) => this.deps.getApproval(approvalId) : undefined,
      annotateApproval: this.deps.annotateApproval
        ? (approvalId, note) => this.deps.annotateApproval!(approvalId, note)
        : undefined,
      save: (next) => this.deps.gateStore!.save(next),
      log: this.deps.log,
    })
    if (outcome === 'retry') return { settled: false, conflict: false }
    return { settled: true, conflict: outcome === 'conflict' }
  }

  private async persistConflict(
    entry: OpenApproval,
    record: GateRecord,
    hitlyDecision: string | undefined,
    detail: string,
    decidedBy: string,
  ): Promise<void> {
    const detectedAt = new Date().toISOString()
    const note =
      `A HITLy decision (${hitlyDecision ?? 'unknown'}) reached a ${entry.gate} gate whose parked tool call was ` +
      `already answered by ${decidedBy}. The decision was not applied. Detail: ${detail}`
    try {
      await this.deps.gateStore?.save({
        ...record,
        status: 'conflict',
        hitlyDecision: hitlyDecision ?? record.hitlyDecision,
        conflict: {
          hitlyDecision: hitlyDecision ?? record.hitlyDecision,
          factoryDecision: record.factoryDecision,
          factoryChannel: record.factoryChannel,
          detectedAt,
          detail: note,
        },
        updatedAt: detectedAt,
      })
    } catch (error) {
      this.deps.log?.('warn', 'hitly reconcile: failed to persist gate conflict', {
        approvalId: entry.approvalId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    this.deps.log?.('warn', 'hitly reconcile: gate conflict, decision not applied', {
      approvalId: entry.approvalId,
      gate: entry.gate,
      hitlyDecision,
      decidedBy,
      detail,
    })
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
