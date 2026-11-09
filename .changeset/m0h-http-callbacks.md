---
"@hitly/core": patch
"@hitly/plugin-http": patch
"@hitly/app": patch
---

M0h HTTP plugin callback upgrades (hitly#106), all pinned by tests:

- Callback auth: `cb_auth_token` sends a per-request Bearer header and is stripped at ingest everywhere it could hide (origin handle AND the caller metadata bag); reviewers never see it in `GET /api/v1/approvals/:id` (`origin`, `envelope.origin`, `origin.resumeHandle`) or in `/original-request` (`canonicalPayload`), including legacy rows (real-Postgres canary tests).
- 5xx safety: after the retry schedule is exhausted the receiver's error body is never stored or served (`body: null`, MU12).
- HMAC: deliveries sign `"<unix seconds>.<raw body>"` with a DEDICATED per-project webhook key registry (`credentials.webhookSigningSecrets`, key id advertised in `X-HITLy-Key-Id`) - never with the resume secret (`HITLY_RESUME_SECRET`, which authenticates origin->HITLy polls). Rotation keeps the outgoing key verifiable for an overlap window; receiver-side `verifyHttpSignature` accepts both keys inside it and refuses after. Known-answer vector tests recompute the MAC over the exact bytes captured on the wire plus the timestamp header.
- SSRF: every attempt (retries included) and every lifecycle POST re-runs the destination check on freshly-resolved, pinned DNS; a flip to private/metadata space is refused without a second connect (production refusal test for lifecycle delivery).
- Retries: 5xx/429/408/425 and transient connect/timeout destination failures are retried with jittered backoff; policy refusals fail closed after one attempt.
- Dedupe: the event id is stable per logical delivery across host retries (`retryResume`) - persisted in `deliveryEventIds` or derived deterministically from (approval, event).
- Lifecycle events (opt-in): opted-in requests additionally receive `presented`, `opened`, `cancelled` and `expired` POSTs from the real host call sites; the default stays the single final-decision POST and a failing lifecycle receiver never fails the reviewer action.
- Typed answers: `parseDecisionBody` carries the reviewer's typed `answer` through to the origin callback (`type: 'answered'`) instead of dropping it; malformed answers are refused at parse time (400), never silently stripped.
- Housekeeping: `affectedRows()` now reads the node-postgres `rowCount` (Postgres UPDATEs previously counted as 0, zeroing the expire sweep's report and blocking scheduler claims).
