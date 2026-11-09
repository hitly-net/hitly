import type { ApprovalEnvelope, OriginRef } from '@hitly/core'
import { envelopeMetadata, originFields } from './origin'
import { isSecretRequestKey, redactRequestPayload } from './redact-request-payload'

export type OriginField = { key: string; label: string; value: string }

/**
 * Reviewer-facing approval view. Redacts origin, envelope (args, _meta,
 * metadata, resume handles), decisions[].payload, and resumeResponse.
 * Response/DTO only: never writes back to the database.
 *
 * Origin display rows are taken from the stored original, then secret-named
 * keys (cb_auth_token, password_type, …) are dropped.
 */
export function redactApprovalForReviewer<T extends { payload: unknown; resumeResponse: unknown }>(args: {
  envelope: ApprovalEnvelope
  origin: OriginRef
  decisions: T[]
}): {
  envelope: ApprovalEnvelope
  origin: OriginRef
  originFields: OriginField[]
  decisions: T[]
} {
  const metadata = envelopeMetadata(args.envelope, args.origin)
  return {
    envelope: redactRequestPayload({
      ...args.envelope,
      metadata,
    }) as ApprovalEnvelope,
    origin: redactRequestPayload(args.origin) as OriginRef,
    originFields: originFields(args.origin).filter((row) => !isSecretRequestKey(row.key)),
    decisions: args.decisions.map((row) => ({
      ...row,
      payload: redactRequestPayload(row.payload),
      resumeResponse: row.resumeResponse ? redactRequestPayload(row.resumeResponse) : row.resumeResponse,
    })),
  }
}
