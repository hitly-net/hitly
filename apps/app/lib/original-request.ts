import { and, eq } from 'drizzle-orm'
import { canonicalJson, sha256Hex, type ApprovalEnvelope, type WorkspaceRole } from '@hitly/core'
import { approvals, evidenceReceipts } from '@hitly/db/schema'
import { getProjectAccess } from './rbac'
import { stripOriginSecrets } from './origin'
import { requireDb, withTenant } from './tenant'
import { decodeTenantJson } from './tenant-crypto'

/**
 * Original create-once request view (hitly#98).
 *
 * Returns the canonical JSON of the stored create-once request (`hitl/request/v0`):
 * the `approvals.envelope` row written once at ingest (see `ingestApproval`; nothing
 * updates this column), tenant-decoded, then serialized with `@hitly/core`'s
 * `canonicalJson` (sorted keys, `JSON.stringify` number formatting). That is the
 * host-normalised stored record — not the requester's raw wire bytes (key order,
 * whitespace, `\u` escapes and number forms are normalised at ingest/`JSON.parse`).
 * Never re-derived from rendered/mutable UI fields. A reviewer can paste the copy
 * into a known-good verifier and check the screen against what was stored
 * (hitl-spec discussion #5: `argsHash` alone only binds action args).
 *
 * Unredacted on purpose: redacting any character would break the hash check, and the
 * same payload is already shown to anyone who can open the approval. Access is the
 * control — identical to the approval detail: session → success for project members;
 * unauthenticated → 401; no workspace / unknown id / foreign workspace / no access →
 * 404. Logs carry only ids and hashes via `summarizeForLog` (payload contents are
 * never logged). Known limitation: integers above `Number.MAX_SAFE_INTEGER` lose
 * precision at ingest `JSON.parse` (e.g. `12345678901234567890` is stored and served
 * as `12345678901234567000`); that is not repaired here.
 *
 * Hash form: hex SHA-256 over Hitly `canonicalJson`, not hitl-spec §5
 * `b64url(SHA-256(JCS(...)))`. Aligning with JCS/b64url is a follow-up — changing
 * `canonicalJson` would rewrite every evidence hash on existing data.
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
    // M0h: origin credentials are never stored here (ingest strips them); strip again
    // defensively so a legacy row can't echo the callback token. For credential-free
    // rows (every row written by current code) this is a no-op: the byte-exact
    // canonical copy and its hash are unchanged for verification.
    const payload = stripOriginSecrets(
      (await decodeTenantJson(args.workspaceId, approval.envelope)) as unknown as ApprovalEnvelope,
    )
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
 * Log-safe summary (hitly#98): only ids and hashes ever reach a log line — never
 * the payload. Values here are non-secret identifiers.
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
