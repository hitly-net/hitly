import { withApiTenant } from '@/lib/api-session'
import { getOriginalRequest } from '@/lib/original-request'
import { createOriginalRequestGet } from '@/lib/original-request-route'

/**
 * Serve the stored create-once `hitl/request/v0` payload as canonical JSON for
 * reviewer verification (hitly#98, hitl-spec discussion #5).
 *
 * Session-authenticated reviewer API only — same authentication and tenancy as
 * `GET /api/v1/approvals/{id}` (the approval detail): workspace member with project
 * access → success; unauthenticated → 401; session with no workspace, unknown id,
 * foreign workspace and no-access → 404. The project API-key path is deliberately
 * absent: origin keys keep their reduced view (`getApprovalForOrigin`) and never
 * read the reviewer-facing payload here. A bearer API key without a session is
 * therefore refused as 401 (no session), not served.
 *
 * The body is the canonical JSON of the stored create-once record (host-normalised
 * envelope), not the raw request bytes — see `lib/original-request.ts`. Only ids
 * and hashes are logged; payload contents never are.
 */
export const GET = createOriginalRequestGet({ withApiTenant, getOriginalRequest })
