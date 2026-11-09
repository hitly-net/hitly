# @hitly/plugin-http

Generic HTTP pause/resume adapter. The origin supplies `resumeUrl`; on decide HITLy POSTs JSON back.

## Callback upgrades (M0h)

Default behaviour is unchanged: a **single** POST of the final decision so n8n Wait (`$execution.resumeUrl`) keeps working (`$json.decision`, `$json.id`, `$json.metadata`).

Optional ingest fields:

| Field | Effect |
| --- | --- |
| `cb_auth_token` / `cbAuthToken` | Sent as `Authorization: Bearer …` on every delivery. Stored on the encrypted origin handle; never echoed in API projections, resumeData, metadata, or logs. |
| `lifecycleEvents` | Opt-in list: `presented`, `opened`, `cancelled`, `expired`. Without this, only the final decision POST is sent. |

### HMAC (optional for receivers)

When the project has a `resumeSecret` (already provisioned for every project), deliveries also send:

- `X-HITLy-Timestamp` — Unix seconds
- `X-HITLy-Event-Id` — stable across retries; receivers MUST dedupe
- `X-HITLy-Key-Id` — `hk_` + first 8 hex of SHA-256(secret)
- `X-HITLy-Signature` — hex HMAC-SHA256 over `timestamp + "." + rawBody`

Verification is optional. Baseline for Grok Bot: Bearer + `get_decision`. To verify:

```ts
import { verifyHttpSignature } from "@hitly/plugin-http"

const result = verifyHttpSignature({
  secret: process.env.HITLY_RESUME_SECRET!,
  rawBody, // exact bytes received
  timestampHeader: req.headers["x-hitly-timestamp"],
  signatureHeader: req.headers["x-hitly-signature"],
  keyIdHeader: req.headers["x-hitly-key-id"],
})
if (!result.ok) reject() // missing | bad_timestamp | skew | bad_signature | key_mismatch
```

Reject timestamps older than 5 minutes. Retries reuse the same `X-HITLy-Event-Id`.

### Typed answers

When the decision payload includes `answer`, the callback `type` is `answered` and `answer` carries the typed value (ready for ask_user). Approvals send `answer: null`.

### Amended values

The stored create-once request is never changed. Approver `editedArgs` travel only in the decision/response callback body.
