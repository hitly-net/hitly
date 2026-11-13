/**
 * Server half of REST ingest: the handler behind POST /api/v1/approvals.
 *
 * Every authenticated-by-key ingest request counts against the shared
 * database limiter (route 'ingest', subject = SHA-256 of the presented API
 * key — the key itself is never stored or logged). Past the budget the
 * request answers 429 with Retry-After before the body is even read.
 * Override with HITLY_RATE_LIMIT_INGEST_LIMIT / HITLY_RATE_LIMIT_INGEST_WINDOW_MS.
 *
 * The response shape and error replies are unchanged from the previous
 * inline route handler; only the limiter gate was added.
 */

import { NextResponse } from 'next/server'
import { argsHash } from '@hitly/core'
import { ingestApproval } from './approvals'
import { createOncePolicy } from './create-once'
import { createRateAcquire, hashIngestSubject, resolveDecision, withRetryAfter, type RateAcquire } from './rate-limit'

/** Per-API-key ingest budget before the shared-database limiter answers 429. */
export const INGEST_LIMIT = 120
export const INGEST_WINDOW_MS = 60_000
export const INGEST_LIMITED_LOG = '[hitly ingest] Request refused: too many requests for this API key.'

const ingestAcquire = createRateAcquire('ingest', { limit: INGEST_LIMIT, windowMs: INGEST_WINDOW_MS })

export interface IngestRouteDeps {
  /** Overrides the limiter for tests: consumes one slot for the hashed key. */
  acquire?: RateAcquire
  log?: (line: string) => void
}

export async function handleIngestPost(request: Request, deps: IngestRouteDeps = {}): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const acquire = deps.acquire ?? ingestAcquire
  try {
    const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing API key' }, { status: 401 })
    }

    const budget = await resolveDecision(acquire, hashIngestSubject(apiKey), INGEST_WINDOW_MS)
    if (!budget.allowed) {
      log(INGEST_LIMITED_LOG)
      return withRetryAfter(NextResponse.json({ error: 'too_many_requests' }, { status: 429 }), budget.retryAfterMs)
    }

    const raw = await request.text()
    if (!raw.trim()) {
      return NextResponse.json(
        {
          error:
            'JSON body required. Put plugin, projectId, runId, and resumeUrl in the POST body (n8n: Send Body), not query parameters.',
        },
        { status: 400 },
      )
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'JSON body must be an object' }, { status: 400 })
    }
    const result = await ingestApproval({
      apiKey,
      body,
      idempotencyKey: request.headers.get('idempotency-key'),
    })

    if (!result.ok) {
      return NextResponse.json(
        'code' in result && result.code
          ? { error: result.error, code: result.code }
          : { error: result.error },
        { status: result.status },
      )
    }

    const envelope = result.approval.envelope as { action?: { args?: Record<string, unknown> }; expiresAt?: string }
    return NextResponse.json({
      id: result.approval.id,
      status: result.approval.status,
      replayed: result.replayed,
      // The expiry the host actually stored (rule/project defaults included),
      // so requester clients never echo a deadline that differs from the row.
      expiresAt: envelope.expiresAt ?? result.approval.expiresAt?.toISOString() ?? null,
      envelope: result.approval.envelope,
      // hitl-spec 3.8 over the stored original args (JCS, b64url SHA-256).
      argsHash: await argsHash(envelope.action?.args ?? {}),
      // hitl-spec 3.2: the published create-once retention period.
      createOnce: createOncePolicy(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ingest failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
