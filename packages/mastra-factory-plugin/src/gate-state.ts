import type { Gate } from './types.ts'

/**
 * The lifecycle of one mirrored gate (one parked Factory tool call).
 *
 * - `open`             — mirrored to HITLy, nobody has decided yet.
 * - `factory_resolved` — the tool call was answered in the Factory surface; the
 *                        HITLy item is being (or has been) closed as decided
 *                        elsewhere. A late HITLy decision on this gate is a
 *                        conflict, never an apply.
 * - `hitly_applied`    — HITLy decided and the decision reached the session.
 * - `conflict`         — both sides acted. Reported, never silently applied.
 */
export type GateStatus = 'open' | 'factory_resolved' | 'hitly_applied' | 'conflict'

export interface GateConflictInfo {
  /** What HITLy recorded: a decision, or the closing status when nobody decided. */
  hitlyDecision?: string
  factoryDecision?: string
  factoryChannel?: string
  detectedAt: string
  detail?: string
}

/** Everything the plugin needs to remember about one gate. */
export interface GateRecord {
  /** `${sessionId}:${toolCallId}:${gate}` — see {@link gateStateKey}. */
  key: string
  sessionId: string
  toolCallId?: string
  gate: Gate
  orgId?: string
  /**
   * The factory whose HITLy project owns `approvalId`. Cancel, read and
   * annotate must go to that project's connection (#211), never the default.
   */
  factoryProjectId?: string
  approvalId?: string
  status: GateStatus
  /** The decision the Factory surface recorded (approved | rejected | answered). */
  factoryDecision?: string
  /** Which Factory surface decided (ui | mcp | auto-approve | unknown). */
  factoryChannel?: string
  factoryResolvedAt?: string
  /** The decision HITLy recorded. */
  hitlyDecision?: string
  conflict?: GateConflictInfo
  /** Requester-cancel attempts made for a Factory-resolved gate (retry budget). */
  cancelAttempts?: number
  /** Set once HITLy confirmed the item is no longer ours to close. */
  cancelledAt?: string
  updatedAt: string
}

export interface GateStateStore {
  load(key: string): Promise<GateRecord | null>
  /** Upsert by `key`. Implementations must be safe to call repeatedly. */
  save(record: GateRecord): Promise<void>
  /** Optional scan for diagnostics and cancel retries. */
  list?(): Promise<GateRecord[]>
}

/** Identity of a gate: one tool call, one gate kind, one session. */
export function gateStateKey(sessionId: string, toolCallId: string | undefined, gate: Gate): string {
  return `${sessionId}:${toolCallId ?? 'none'}:${gate}`
}

export const DEFAULT_GATE_STATE_MAX = 2000

/**
 * Process-local gate memory. The default store: correct within one process and
 * the fallback whenever Factory storage is unavailable. The Factory host wires a
 * durable store (see `factory-seams.ts`) so both properties — the Factory-side
 * close and the conflict refusal — survive a restart.
 */
export function createMemoryGateStateStore(max: number = DEFAULT_GATE_STATE_MAX): GateStateStore {
  const records = new Map<string, GateRecord>()
  return {
    async load(key) {
      const record = records.get(key)
      if (record) {
        // Refresh recency on read so an actively-decided gate is never evicted
        // while the Map is at capacity.
        records.delete(key)
        records.set(key, record)
      }
      return record ?? null
    },
    async save(record) {
      records.delete(record.key)
      records.set(record.key, record)
      while (records.size > max) {
        const oldest = records.keys().next()
        if (oldest.done) break
        records.delete(oldest.value)
      }
    },
    async list() {
      return [...records.values()]
    },
  }
}

const USER_ANSWERED_PREFIX = 'User answered:'

function resolvedAction(value: unknown): string | null {
  return value === 'approved' || value === 'rejected' ? value : null
}

/**
 * Did the Factory surface just resolve this gated tool call?
 *
 * The resumed pass of a suspended tool reaches `postToolObserver` with the same
 * tool call id and the tool's final output. Only two gates suspend, so only two
 * carry a signal:
 *
 * - `submit_plan` → `{ submittedPlan: { action: 'approved' | 'rejected' } }`
 *   (`@mastra/core` builtin, resumed pass).
 * - `ask_user`    → `{ content: 'User answered: …' }` — free text, no structured
 *   field, so the upstream marker prefix is the only signal. Deliberately no
 *   fuzzy matching: an unrecognised shape means "not a resolution".
 *
 * `review` never suspends (the observer fires with the verdict already produced),
 * so it has no Factory-side resolution to detect.
 */
export function detectFactoryResolution(gate: Gate, output: unknown): string | null {
  if (typeof output !== 'object' || output === null) return null
  const record = output as Record<string, unknown>
  if (gate === 'plan') {
    const submitted = record.submittedPlan
    if (typeof submitted !== 'object' || submitted === null) return null
    return resolvedAction((submitted as Record<string, unknown>).action)
  }
  if (gate === 'ask_user') {
    return typeof record.content === 'string' && record.content.startsWith(USER_ANSWERED_PREFIX)
      ? 'answered'
      : null
  }
  return null
}

/** Reason carried to HITLy when the plugin closes a gate the Factory decided. */
export function decidedElsewhereReason(decision: string, channel: string): string {
  return `Decided in Mastra Factory: ${decision} (channel: ${channel}). HITLy gate closed as decided elsewhere.`
}

/** How many requester cancels to attempt before leaving the item to a human. */
export const DEFAULT_MAX_CANCEL_ATTEMPTS = 10

export type GateCloseOutcome = 'cancelled' | 'conflict' | 'closed' | 'retry' | 'gave-up'

export interface GateCloseDeps {
  cancelApproval(approvalId: string, reason?: string): Promise<void>
  /** Authoritative read of the HITLy row — used to tell a mid-air decision from a plain close. */
  getApproval?(approvalId: string): Promise<{ status: string; decision: string | null }>
  annotateApproval?(approvalId: string, note: string): Promise<{ recorded: boolean }>
  save(record: GateRecord): Promise<void>
  log?(level: string, message: string, meta?: Record<string, unknown>): void
  maxCancelAttempts?: number
}

function httpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

function hitlyHadADecision(authority: { status: string; decision: string | null } | null): boolean {
  if (!authority) return false
  return authority.status === 'decided' || (authority.status === 'failed_resume' && authority.decision !== null)
}

/**
 * Close a HITLy gate that the Factory surface decided first, via requester
 * cancel. The caller persists `status: 'factory_resolved'` BEFORE calling this,
 * so a crash between the two leaves the reconciler to retry — and a late HITLy
 * decision is refused either way.
 *
 * Outcomes:
 * - `cancelled` — HITLy closed the item; nobody in HITLy will answer it.
 * - `conflict`  — HITLy answers 409 because a decision (or a failed delivery of
 *   one) is already recorded: both sides acted. Recorded and annotated, never applied.
 * - `closed`    — HITLy answers 409 because the row expired or was withdrawn
 *   with no decision. Not a conflict: nobody decided.
 * - `retry`     — transient failure; the reconciler tries again next tick.
 * - `gave_up`   — the cancel kept failing past the attempt budget. The item
 *   stays pending in HITLy for a human; any late decision it receives is
 *   still refused as a conflict, because the gate record says Factory won.
 */
export async function closeGateAsDecidedElsewhere(
  record: GateRecord,
  deps: GateCloseDeps,
): Promise<GateCloseOutcome> {
  const approvalId = record.approvalId
  if (!approvalId) return 'closed'
  if (record.cancelledAt) return 'cancelled'

  const attempts = record.cancelAttempts ?? 0
  const maxAttempts = deps.maxCancelAttempts ?? DEFAULT_MAX_CANCEL_ATTEMPTS
  if (attempts >= maxAttempts) {
    deps.log?.('error', 'hitly: giving up on closing Factory-decided gate in HITLy', {
      approvalId,
      gate: record.gate,
      attempts,
    })
    return 'gave-up'
  }

  const attemptAt = new Date().toISOString()
  try {
    await deps.cancelApproval(
      approvalId,
      decidedElsewhereReason(record.factoryDecision ?? 'unknown', record.factoryChannel ?? 'unknown'),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await deps.save({ ...record, cancelAttempts: attempts + 1, updatedAt: attemptAt })
    if (httpStatus(error) === 409) {
      let authority: { status: string; decision: string | null } | null = null
      try {
        authority = (await deps.getApproval?.(approvalId)) ?? null
      } catch {
        authority = null
      }
      if (hitlyHadADecision(authority)) {
        const detectedAt = new Date().toISOString()
        const hitlyDecision = authority!.decision ?? authority!.status
        const detail =
          `HITLy decided this gate before the Factory-side close landed. ` +
          `HITLy: "${hitlyDecision}". Factory: "${record.factoryDecision ?? 'unknown'}"` +
          `${record.factoryChannel ? ` (channel: ${record.factoryChannel})` : ''}. The HITLy decision was not applied.`
        await deps.save({
          ...record,
          status: 'conflict',
          hitlyDecision,
          conflict: {
            hitlyDecision,
            factoryDecision: record.factoryDecision,
            factoryChannel: record.factoryChannel,
            detectedAt,
            detail,
          },
          updatedAt: detectedAt,
        })
        if (deps.annotateApproval) {
          const note = await deps
            .annotateApproval(approvalId, detail)
            .catch(() => ({ recorded: false } as { recorded: boolean }))
          deps.log?.('info', 'hitly: HITLy decided first — conflict recorded, decision not applied', {
            approvalId,
            gate: record.gate,
            hitlyDecision,
            factoryDecision: record.factoryDecision,
            annotated: note.recorded,
          })
        } else {
          deps.log?.('warn', 'hitly: HITLy decided first — conflict recorded, decision not applied', {
            approvalId,
            gate: record.gate,
            hitlyDecision,
            factoryDecision: record.factoryDecision,
          })
        }
        return 'conflict'
      }
      // Expired or withdrawn with no decision: not ours to close, nobody decided.
      const closedAt = new Date().toISOString()
      await deps.save({ ...record, cancelledAt: closedAt, hitlyDecision: authority?.status, updatedAt: closedAt })
      deps.log?.('info', 'hitly: Factory-decided gate was already closed in HITLy', {
        approvalId,
        gate: record.gate,
        hitlyStatus: authority?.status ?? 'unknown',
      })
      return 'closed'
    }
    deps.log?.('warn', 'hitly: requester cancel failed, will retry', {
      approvalId,
      gate: record.gate,
      attempts: attempts + 1,
      error: message,
    })
    return 'retry'
  }

  const cancelledAt = new Date().toISOString()
  await deps.save({ ...record, cancelAttempts: attempts + 1, cancelledAt, updatedAt: cancelledAt })
  deps.log?.('info', 'hitly: closed HITLy gate decided in Factory', {
    approvalId,
    gate: record.gate,
    factoryDecision: record.factoryDecision,
    factoryChannel: record.factoryChannel,
  })
  return 'cancelled'
}
