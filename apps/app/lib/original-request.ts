import { and, eq } from 'drizzle-orm'
import { argsHash as jcsArgsHash, canonicalJson, jcsHash, sha256Hex, type ApprovalEnvelope, type WorkspaceRole } from '@hitly/core'
import { approvals, evidenceReceipts } from '@hitly/db/schema'
import { getProjectAccess } from './rbac'
import { redactRequestPayload } from './redact-request-payload'
import { requireDb, withTenant } from './tenant'
import { decodeTenantJson } from './tenant-crypto'

/**
 * Original create-once request view (hitly#98).
 *
 * Reads the stored create-once request (`hitl/request/v0`) from `approvals.envelope`
 * — the row written once at ingest (see `ingestApproval`; nothing updates this
 * column). Tenant-decoded, then hashed over that stored original. The JSON served
 * for display/copy/download is the same record after secret redaction (`cb_auth_token`,
 * resume handles, secret-like fields). Never re-derived from rendered/mutable UI
 * fields, and never from `editedArgs` (those live only on the decide/read path).
 *
 * Access is identical to the approval detail: session → success for project members;
 * unauthenticated → 401; no workspace / unknown id / foreign workspace / no access →
 * 404. Logs carry only ids and hashes via `summarizeForLog` (payload contents are
 * never logged). Known limitation: integers above `Number.MAX_SAFE_INTEGER` lose
 * precision at ingest `JSON.parse` (e.g. `12345678901234567890` is stored and served
 * as `12345678901234567000`); that is not repaired here.
 *
 * Hash forms: `payloadHash` / `argsHash` are the hitl-spec 3.8 / 5 wire form,
 * `b64url(SHA-256(JCS(...)))` over the **stored original** (pre-redaction) so a
 * reviewer can verify off-host. `payloadSha256` / `argsSha256` stay hex SHA-256
 * over HITLy `canonicalJson` of that original because they anchor the
 * hitly.evidence.v1 chain (`proposed_sha256`).
 */

export type OriginalRequestOk = {
  ok: true
  /** The approval id (== create-once requestId of the stored request). */
  requestId: string
  /** Stored payload after secret redaction, canonical JSON (sorted keys, no insignificant whitespace). */
  canonicalPayload: string
  /** sha256 hex of the stored original (pre-redaction) canonical JSON. */
  payloadSha256: string
  /** sha256 of the canonical action args; equals the requested event's `proposed_sha256`. */
  argsSha256: string
  /** hitl-spec 5: b64url(SHA-256(JCS(stored payload))). */
  payloadHash: string
  /** hitl-spec 3.8: b64url(SHA-256(JCS(action.args))) — the request's argsHash. */
  argsHash: string
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

    // The create-once record itself — decode in place, never rebuild from UI fields
    // or from editedArgs. Hash the stored original, then redact for the served JSON.
    const payload = (await decodeTenantJson(args.workspaceId, approval.envelope)) as unknown as ApprovalEnvelope
    const originalCanonical = canonicalJson(payload)
    const payloadSha256 = await sha256Hex(originalCanonical)
    const argsSha256 = await sha256Hex(canonicalJson(payload.action?.args ?? {}))
    const canonicalPayload = canonicalJson(redactRequestPayload(payload))

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
      payloadHash: await jcsHash(payload),
      argsHash: await jcsArgsHash(payload.action?.args ?? {}),
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
