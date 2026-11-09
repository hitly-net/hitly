import { jcsHash } from '@hitly/core'

/**
 * Create-once retention (hitl-spec 3.2).
 *
 * A repeat submission with the same `Idempotency-Key` in the same project,
 * made with the API key that created the request, returns the existing
 * request, and never creates a second ask, when either:
 *
 * - the existing request is still open (`pending` or `failed_resume`), at any
 *   age; or
 * - it is closed (`decided`, `expired` or `cancelled`) and was created less
 *   than the create-once retention period ago.
 *
 * Same-key replay also requires a matching `payloadHash` (JCS of
 * `payloadHashInput` / `envelopePayloadHash` below). A different hash is
 * `409 idempotency_conflict`. The project log line for that conflict includes
 * `approvalId` and does not log the request payload or secrets.
 *
 * Replay is per API key (consistent with key-scoped cancel and the pending
 * list): a sibling key in the same project never replays another key's
 * request. While the id is still held by a request the calling key cannot
 * replay, that submission is rejected with `409` and discloses nothing about
 * the other request.
 *
 * After the period, the same key MAY create a new request. The period is
 * published in every ingest response (`createOnce.retentionSeconds`) and in
 * the API docs. Requesters should keep their single-use record for a spent
 * requestId (hitl-spec 3.8) at least this long.
 *
 * Default 10 days: the shortest Cloud plan keeps closed items for 10 days
 * after they close (`completedRetentionDays`), so a request is always still
 * stored for the whole window. Self-hosted operators may set
 * HITLY_CREATE_ONCE_RETENTION_DAYS (whole days, 1-3650).
 */

export type CreateOnceEnv = Record<string, string | undefined>

export const DEFAULT_CREATE_ONCE_RETENTION_DAYS = 10
const MAX_DAYS = 3650
const DAY_MS = 24 * 60 * 60 * 1000

export function createOnceRetentionDays(env: CreateOnceEnv = process.env): number {
  const raw = env.HITLY_CREATE_ONCE_RETENTION_DAYS?.trim()
  if (!raw) return DEFAULT_CREATE_ONCE_RETENTION_DAYS
  if (!/^\d+$/.test(raw)) return DEFAULT_CREATE_ONCE_RETENTION_DAYS
  const days = Number(raw)
  if (days < 1 || days > MAX_DAYS) return DEFAULT_CREATE_ONCE_RETENTION_DAYS
  return days
}

export function createOnceRetentionMs(env: CreateOnceEnv = process.env): number {
  return createOnceRetentionDays(env) * DAY_MS
}

/** Oldest `createdAt` a closed request may have and still be replayed (exclusive). */
export function createOnceCutoff(now: number = Date.now(), env: CreateOnceEnv = process.env): Date {
  return new Date(now - createOnceRetentionMs(env))
}

/** True when a request created at `createdAt` is inside the window at `now` (strict: the boundary instant is outside). */
export function withinCreateOnceWindow(createdAt: Date, now: number = Date.now(), env: CreateOnceEnv = process.env) {
  return createdAt.getTime() > createOnceCutoff(now, env).getTime()
}

export function createOncePolicy(env: CreateOnceEnv = process.env) {
  return { retentionSeconds: createOnceRetentionDays(env) * 24 * 60 * 60 }
}

/**
 * Object hashed as create-once payloadHash: the ingested create-once record
 * (`plugin.ingest()` output stored on `approvals.envelope`) after
 * `JSON.parse(JSON.stringify(...))` so ingest/JSONB match the stored row
 * (`undefined` keys dropped). JCS then sorts members, so shuffled
 * `action.args` key order still matches.
 *
 * Included: every field the plugin wrote onto that record — `action` (name +
 * args), `allowedActions`, gating/context (`reasonRequired`, `contextMarkdown`,
 * `metadata`, `externalUrls`, `attachments`), `resumeSchema`, `expiresAt`,
 * `editableFields`, `editReason`, envelope evidence fields (`traceId`, `spanId`,
 * `agentId`, `systemId`, `inventoryId`, `policyId`, `policyRationale`,
 * `riskTier`, `toolName`, `sensitivity`, `dataCategories`), and the nested
 * `origin` (`plugin`, `projectId`, `runId`, `stepId`, `resumeHandle` including
 * origin URLs merged from the project such as `mastraBaseUrl`, `details`, and
 * origin evidence fields).
 *
 * Excluded (never hashed): HTTP headers (`Authorization`, `Idempotency-Key`,
 * `Content-Type`, `x-hitly-client`); API key material; host-assigned
 * create-once fields (`id`, `status`, timestamps, `requesterKeyId`, `replayed`,
 * `createOnce`, response `argsHash`); project credential secrets
 * (`resumeSecret`, `token`) which are not copied onto the envelope; unmapped
 * extra keys on the raw POST body (dropped at ingest).
 */
export function payloadHashInput(envelope: unknown): unknown {
  return JSON.parse(JSON.stringify(envelope)) as unknown
}

/** Create-once payloadHash: `b64url(SHA-256(JCS(payloadHashInput(envelope))))`. */
export async function envelopePayloadHash(envelope: unknown): Promise<string> {
  return jcsHash(payloadHashInput(envelope))
}