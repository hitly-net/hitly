import { and, eq } from 'drizzle-orm'
import { canonicalJson, sha256Hex, type ApprovalEnvelope, type WorkspaceRole } from '@hitly/core'
import { approvals, evidenceReceipts } from '@hitly/db/schema'
import { getProjectAccess } from './rbac'
import { requireDb, withTenant } from './tenant'
import { decodeTenantJson } from './tenant-crypto'

/**
 * Original create-once request view (hitly#98).
 *
 * Returns the ORIGINAL ingested request (`hitl/request/v0`) exactly as persisted,
 * never re-derived from rendered/mutable fields: the create-once `approvals.envelope`
 * row written once at ingest (see `ingestApproval`; nothing updates this column) and
 * tenant-decrypted, serialized with `@hitly/core`'s `canonicalJson` — the same
 * canonicalization the evidence chain hashes over — so a reviewer can paste it into a
 * known-good host/verifier and check the screen against what was stored
 * (hitl-spec discussion #5: `argsHash` alone only binds action args, not the
 * human-facing payload; the create-once record is the source of truth).
 *
 * REDACTION vs EXACTNESS (deliberate, flagged for review): the view is byte-exact,
 * with NO secret redaction. Byte fidelity is the whole feature — redacting any byte
 * would break the off-host verification this exists for, and the payload is already
 * shown (unredacted) to anyone who can open this approval (action args, context,
 * attachments render on the detail screen; the detail JSON disclosure too). Access is
 * therefore the control, identical to the approval detail: session-authenticated
 * workspace member with project access, cross-tenant and non-member reads get 404.
 * The repo's secret-redaction policy (`redactSecrets`, lib/auth-logging.ts) is applied
 * to everything LEAVING via logs: this module only ever logs ids and hashes — see
 * `summarizeForLog`. If product later wants a shareable redacted export, that must be
 * a separate explicit mode, never the default view.
 */

export type OriginalRequestOk = {
  ok: true
  /** The approval id (== create-once requestId of the stored request). */
  requestId: string
  /** The stored payload, canonical JSON (sorted keys, no insignificant whitespace). */
  canonicalPayload: string
  /** sha256 hex of `canonicalPayload` — what a verifier recomputes over the copy. */
  payloadSha256: string
  /** sha256 of the canonical action args; equals the requested event's `proposed_sha256`. */
  argsSha256: string
  /** The requested event's evidence receipt anchor (hitly#97 chain), when durable. */
  evidence?: { eventId: string; contentSha256: string; seq: number }
}

export type OriginalRequestErr = { ok: false; error: string; status: number }

export async function getOriginalRequest(args: {
  approvalId: string
  workspaceId: string
  userId: string
  workspaceRole: WorkspaceRole
}): Promise<OriginalRequestOk | OriginalRequestErr> {
  return withTenant(args.workspaceId, async () => {
    const database = requireDb()

    // Same access path as getApprovalDetail: unknown id, foreign workspace and
    // no-project-access all collapse to 404 (no existence leak).
    const rows = await database
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, args.approvalId), eq(approvals.workspaceId, args.workspaceId)))
      .limit(1)
    const approval = rows[0]
    if (!approval) return { ok: false, error: 'Not found', status: 404 }

    const access = await getProjectAccess({
      projectId: approval.projectId,
      userId: args.userId,
      workspaceRole: args.workspaceRole,
    })
    if (!access) return { ok: false, error: 'Not found', status: 404 }

    // The create-once record itself — decode in place, never rebuild from UI fields.
    const payload = (await decodeTenantJson(args.workspaceId, approval.envelope)) as unknown as ApprovalEnvelope
    const canonicalPayload = canonicalJson(payload)
    const payloadSha256 = await sha256Hex(canonicalPayload)
    const argsSha256 = await sha256Hex(canonicalJson(payload.action?.args ?? {}))

    // Evidence anchor from the #97 chain: the requested event's stored content hash.
    const receiptRows = await database
      .select({
        eventId: evidenceReceipts.eventId,
        contentSha256: evidenceReceipts.contentSha256,
        seq: evidenceReceipts.seq,
      })
      .from(evidenceReceipts)
      .where(
        and(
          eq(evidenceReceipts.approvalId, approval.id),
          eq(evidenceReceipts.workspaceId, args.workspaceId),
          eq(evidenceReceipts.eventType, 'requested'),
        ),
      )
      .limit(1)
    const receipt = receiptRows[0]

    const result: OriginalRequestOk = {
      ok: true,
      requestId: approval.id,
      canonicalPayload,
      payloadSha256,
      argsSha256,
    }
    if (receipt) {
      result.evidence = { eventId: receipt.eventId, contentSha256: receipt.contentSha256, seq: receipt.seq }
    }
    return result
  })
}

/**
 * Log-safe summary (secret-redaction policy, hitly#98): only ids and hashes ever
 * reach a log line — never the payload bytes. Values here are non-secret identifiers;
 * callers may additionally pass the line through `redactSecrets`.
 */
export function summarizeForLog(result: OriginalRequestOk): {
  requestId: string
  payloadSha256: string
  argsSha256: string
  evidenceEventId?: string
} {
  const summary: { requestId: string; payloadSha256: string; argsSha256: string; evidenceEventId?: string } = {
    requestId: result.requestId,
    payloadSha256: result.payloadSha256,
    argsSha256: result.argsSha256,
  }
  if (result.evidence) summary.evidenceEventId = result.evidence.eventId
  return summary
}
