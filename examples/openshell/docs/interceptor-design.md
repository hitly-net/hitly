# HITLy Gateway Interceptor Design

**Status:** Draft design for PM/Derek review and Test  
**Target:** OpenShell 0.1.2 production VM (`openshell` / Tailscale `100.106.191.81`)  
**Scope:** Demo-friendly interceptor; no Cloud/GA changes, no plugin HMAC changes

---

## Executive Summary

The HITLy gateway interceptor **verifies that a human decision exists in HITLy before allowing OpenShell to commit a draft policy chunk**. This provides defense-in-depth by ensuring that:

1. **mTLS** proves the caller is the authorized HITLy plugin client
2. **HITLy decision state** proves a human reviewer explicitly accepted or rejected the chunk in the HITLy inbox

Without this interceptor, a compromised mTLS client certificate could approve chunks directly without human review. With the interceptor, the attacker would also need to compromise HITLy's decision database or API key.

---

## 1. Threat Model

### What mTLS proves (current)

- **Caller identity:** The gRPC client possesses the mTLS client certificate (`.pem` files under `~/.config/openshell/gateways/openshell/mtls/`)
- **Transport security:** Connection is authenticated and encrypted
- **Gateway scope:** Caller has `config:write` + workspace `admin` role (per proto `authorization` annotations)

### What mTLS does NOT prove

- **Human approval:** A compromised mTLS cert or stolen client key can call `ApproveDraftChunk` without human review
- **HITLy decision:** No proof that the chunk was reviewed in HITLy inbox or that a human clicked Accept/Reject
- **Evidence chain:** No link between the gRPC call and a signed HITLy evidence receipt

### What the interceptor adds

- **Human-in-the-loop verification:** Before allowing `ApproveDraftChunk` or `RejectDraftChunk`, the interceptor queries HITLy to confirm:
  - A matching approval exists (by `sandbox:chunkId` runId)
  - The approval status is `decided` (not `pending`, `expired`, `cancelled`, `failed_resume`)
  - The decision matches the gRPC method:
    - `ApproveDraftChunk` → HITLy decision must be `accept`
    - `RejectDraftChunk` → HITLy decision must be `reject` or `cancel`
- **Defense-in-depth:** An attacker now needs to compromise **both** the mTLS cert **and** the HITLy API key (or the HITLy decision database) to bypass human review

### Residual risks (out of scope for this PR)

- **Replay attacks:** The interceptor does not enforce `request_id` uniqueness or prevent re-approving the same chunk after rejection (OpenShell's own idempotency handles this at the gateway level)
- **Time-of-check-to-time-of-use (TOCTOU):** A decision could change between the interceptor check and the gRPC handler execution (acceptable: the handler's own `review_token` check provides TOCTOU protection)
- **Compromised HITLy API key:** If the interceptor's HITLy API key is stolen, an attacker can forge approval status queries (mitigation: rotate keys, restrict API key to read-only `GET /api/v1/approvals/:id`)
- **Sentry/silicon watchdog:** This interceptor does not replace NVIDIA Sentry or OpenShell TUI monitoring

---

## 2. Intercepted gRPC Methods

The interceptor targets exactly **two methods** from `openshell.v1.OpenShell`:

```proto
rpc ApproveDraftChunk(ApproveDraftChunkRequest) returns (ApproveDraftChunkResponse) {
  option (openshell.options.v1.authorization) = {
    auth_mode: "bearer"
    scope: "config:write"
    workspace_role: "admin"
  };
}

rpc RejectDraftChunk(RejectDraftChunkRequest) returns (RejectDraftChunkResponse) {
  option (openshell.options.v1.authorization) = {
    auth_mode: "bearer"
    scope: "config:write"
    workspace_role: "admin"
  };
}
```

### Why these methods?

- **Decision commit point:** These are the **only** methods that commit a human decision to OpenShell's live policy
- **INTERCEPTABLE_METHODS pattern:** While the proto does not currently expose an `INTERCEPTABLE` annotation, these methods are conceptually the right boundary for a HITL gate
- **Fail-closed:** If the interceptor is misconfigured or HITLy is unreachable, these methods fail with `PERMISSION_DENIED`, blocking policy changes until the issue is resolved

### Methods NOT intercepted (out of scope)

- `GetDraftPolicy` — read-only, no decision commit
- `ApproveAllDraftChunks` — bulk approval (future: may add interceptor support, but requires batch verification design)
- `EditDraftChunk` — in-place edit (no decision commit; the subsequent `ApproveDraftChunk` is intercepted)
- `UndoApproval` — reversal (out of scope for this PR; may add later)

---

## 3. Mapping: gRPC Request → HITLy Approval

### The challenge

The interceptor receives a gRPC `ApproveDraftChunkRequest` or `RejectDraftChunkRequest` with:

```proto
message ApproveDraftChunkRequest {
  openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
  string sandbox = 1;
  string chunk_id = 2;
  string review_token = 4;  // Opaque, internal to OpenShell
  string request_id = 5;    // Optional idempotency UUID
}
```

The interceptor needs to find the corresponding HITLy approval. **The approval is not passed in the gRPC request.**

### Solution: Derive HITLy `runId` from `sandbox:chunkId`

When the HITLy poller creates an approval (via `POST /api/v1/approvals`), it sets:

```typescript
{
  plugin: 'openshell',
  projectId: 'prj_xyz',
  workspace: 'my-workspace',
  sandbox: 'sandbox-123',
  chunkId: 'chunk-456',
  // ... other fields
}
```

The `@hitly/plugin-openshell` `ingest()` function sets:

```typescript
origin: {
  plugin: 'openshell',
  projectId: 'prj_xyz',
  runId: `${sandbox}:${chunkId}`,  // e.g., "sandbox-123:chunk-456"
  resumeHandle: { gatewayAddr, workspace, sandbox, chunkId, reviewToken },
  details: { workspace, sandbox, chunkId }
}
```

**The interceptor reconstructs `runId = ${sandbox}:${chunkId}` from the gRPC request and queries HITLy for an approval with matching `origin.runId`.**

### Trade-offs: Why `runId` mapping?

**Option 1: Pass `approvalId` in gRPC request metadata** (e.g., `x-hitly-approval-id: apr_xyz`)  
❌ **Rejected:** Requires modifying `@hitly/plugin-openshell` to inject the `approvalId` into gRPC metadata, which:
- Leaks HITLy implementation details into the OpenShell client
- Requires changes to `packages/plugin-openshell` (out of scope for "interceptor only" PR)
- Makes the OpenShell client HITLy-aware (violates separation of concerns)

**Option 2: Query HITLy by `runId = sandbox:chunkId`** (chosen)  
✅ **Adopted:** The interceptor:
1. Parses `sandbox` and `chunk_id` from the gRPC request
2. Queries HITLy `GET /api/v1/approvals?runId=${sandbox}:${chunkId}` (or scans approvals with matching `origin.runId` if no direct query API exists)
3. Verifies the approval status and decision

**Pros:**
- No changes to `@hitly/plugin-openshell`
- No gRPC metadata pollution
- Interceptor is self-contained

**Cons:**
- Requires a HITLy API endpoint that can query by `origin.runId` (see section 4)
- If multiple approvals exist for the same `sandbox:chunkId` (e.g., re-approval after rejection), the interceptor must choose the **latest** by `createdAt` or `updatedAt`

**Option 3: Store `chunkId → approvalId` mapping in interceptor's own database**  
❌ **Rejected:** Adds state management complexity, cache invalidation, and failure modes to the interceptor. The source of truth is HITLy's database; the interceptor should query it directly.

---

## 4. HITLy API for Interceptor

The interceptor needs a **read-only** API to check approval status by `origin.runId`.

### Proposed API: `GET /api/v1/approvals?runId=<runId>&plugin=openshell`

**Request:**
```
GET /api/v1/approvals?runId=sandbox-123:chunk-456&plugin=openshell
Authorization: Bearer hitly_...
```

**Response (200 OK):**
```json
{
  "approvals": [
    {
      "id": "apr_xyz",
      "status": "decided",
      "decision": "accept",
      "createdAt": "2026-09-29T10:00:00Z",
      "updatedAt": "2026-09-29T10:05:00Z"
    }
  ]
}
```

**Response (404 Not Found):**
```json
{
  "error": "No approval found for runId sandbox-123:chunk-456"
}
```

**Implementation notes:**
1. **New route:** `apps/app/app/api/v1/approvals/by-run-id/route.ts` (or extend existing `/api/v1/approvals/route.ts` with query param)
2. **Query:** `SELECT id, status, ... FROM approvals WHERE origin->>'runId' = $1 AND plugin = $2 ORDER BY updatedAt DESC LIMIT 1`
   - Postgres JSONB `->>` operator extracts `origin.runId` as text
   - Filter by `plugin = 'openshell'` to scope to OpenShell approvals
   - Order by `updatedAt DESC` to get the **latest** approval if multiple exist
3. **Auth:** API key from `Authorization: Bearer hitly_...` header (same as `POST /api/v1/approvals` ingest flow)
4. **Scope:** Read-only; no decision mutation

### Alternative: Use existing `GET /api/v1/approvals/:id` (NOT VIABLE)

The interceptor does not know the `approvalId` (see section 3). This API requires the approval ID as a path parameter, so it cannot be used for `runId` lookup.

### Fallback: Scan all approvals in memory (DEMO ONLY)

If the new API endpoint is not implemented in this PR, the interceptor can:
1. Query `GET /api/v1/inbox` (requires session auth, not API key — not viable for interceptor)
2. **OR** maintain a lightweight in-memory cache of `runId → approvalId` mappings by polling HITLy periodically (cache invalidation risk, not production-ready)

**Decision:** Implement the new `GET /api/v1/approvals?runId=...` endpoint in this PR. It is a small, self-contained change that unblocks the interceptor.

---

## 5. Allow/Deny Decision Matrix

The interceptor enforces the following rules:

| gRPC Method           | HITLy Status     | HITLy Decision | Interceptor Action |
|-----------------------|------------------|----------------|--------------------|
| `ApproveDraftChunk`   | `decided`        | `accept`       | ✅ Allow           |
| `ApproveDraftChunk`   | `decided`        | `reject`       | ❌ Deny (mismatch) |
| `ApproveDraftChunk`   | `decided`        | `cancel`       | ❌ Deny (mismatch) |
| `ApproveDraftChunk`   | `decided`        | `edit`         | ❌ Deny (edit is not a terminal decision) |
| `ApproveDraftChunk`   | `pending`        | (none)         | ❌ Deny (awaiting human) |
| `ApproveDraftChunk`   | `expired`        | (none)         | ❌ Deny (expired) |
| `ApproveDraftChunk`   | `cancelled`      | `cancel`       | ❌ Deny (cancelled) |
| `ApproveDraftChunk`   | `failed_resume`  | `accept`       | ⚠️ Allow (decision exists, resume failed) |
| `RejectDraftChunk`    | `decided`        | `reject`       | ✅ Allow           |
| `RejectDraftChunk`    | `decided`        | `cancel`       | ✅ Allow (cancel = soft reject) |
| `RejectDraftChunk`    | `decided`        | `accept`       | ❌ Deny (mismatch) |
| `RejectDraftChunk`    | `pending`        | (none)         | ❌ Deny (awaiting human) |
| `RejectDraftChunk`    | `expired`        | (none)         | ❌ Deny (expired) |
| `RejectDraftChunk`    | `cancelled`      | `cancel`       | ❌ Deny (cancelled without decision) |
| `RejectDraftChunk`    | `failed_resume`  | `reject`       | ⚠️ Allow (decision exists, resume failed) |
| (any method)          | (no approval)    | (none)         | ❌ Deny (approval not found) |

### Key behaviors

1. **Exact decision match:** `ApproveDraftChunk` requires HITLy decision `accept`; `RejectDraftChunk` requires HITLy decision `reject` or `cancel`
2. **Fail-closed for pending:** If the approval is still `pending` (human has not decided), the interceptor denies the request with `PERMISSION_DENIED`
3. **Allow `failed_resume`:** If the decision was made (`decided` status) but the resume call failed (`failed_resume` status), the interceptor **allows** the request because the human decision exists (the resume failure is a separate operational issue; the reviewer explicitly chose to accept/reject)
4. **Deny `cancelled`:** If the approval was force-cancelled (`cancelled` status), the interceptor denies the request (no decision was made)
5. **Deny `expired`:** If the approval expired before a decision, the interceptor denies the request

### Error responses

When the interceptor denies a request, it returns a gRPC error:

```
code: PERMISSION_DENIED
message: "HITLy approval required: <reason>"
details: { sandbox: "...", chunk_id: "...", runId: "...", hitlyStatus: "...", hitlyDecision: "..." }
```

Examples:
- `"HITLy approval required: no approval found for runId sandbox-123:chunk-456"`
- `"HITLy approval required: approval apr_xyz is still pending (awaiting human decision)"`
- `"HITLy approval required: decision mismatch (HITLy: reject, gRPC: ApproveDraftChunk)"`
- `"HITLy approval required: HITLy API unreachable (fail-closed)"`

---

## 6. Configuration: Demo-Friendly and Opt-In

The interceptor is **opt-in** by default and requires explicit configuration to enable. This ensures it does not break existing setups or CI/test environments.

### Environment variables (interceptor)

```bash
# Enable HITLy interceptor (default: false, must be set to "true" or "1" to enable)
OPENSHELL_HITLY_INTERCEPTOR_ENABLED=true

# HITLy API URL (required if interceptor is enabled)
OPENSHELL_HITLY_API_URL=http://localhost:3001

# HITLy project API key (required if interceptor is enabled)
# Must have permission to query GET /api/v1/approvals?runId=...
OPENSHELL_HITLY_API_KEY=hitly_...

# HITLy project ID (required if interceptor is enabled)
OPENSHELL_HITLY_PROJECT_ID=prj_...

# Request timeout for HITLy API calls (default: 5000ms)
OPENSHELL_HITLY_INTERCEPTOR_TIMEOUT_MS=5000

# Fail-open mode (default: false, set to "true" ONLY for testing/demo)
# If true, allow requests even if HITLy API is unreachable (NOT FOR PRODUCTION)
OPENSHELL_HITLY_INTERCEPTOR_FAIL_OPEN=false
```

### Fail-closed by default

If the HITLy API is unreachable (network error, 500, timeout), the interceptor **denies** the request by default (`FAIL_OPEN=false`). This ensures human-in-the-loop enforcement is not silently bypassed.

**Exception:** For demo/testing, set `FAIL_OPEN=true` to allow requests even if HITLy is down. This mode logs a warning and should **never** be used in production.

### Configuration validation (startup)

The interceptor validates its configuration at startup:

1. If `OPENSHELL_HITLY_INTERCEPTOR_ENABLED=false` (default), the interceptor is a no-op (does not intercept requests)
2. If `OPENSHELL_HITLY_INTERCEPTOR_ENABLED=true`:
   - Check `OPENSHELL_HITLY_API_URL` is set (non-empty)
   - Check `OPENSHELL_HITLY_API_KEY` is set and starts with `hitly_`
   - Check `OPENSHELL_HITLY_PROJECT_ID` is set and starts with `prj_`
   - If any required variable is missing, **fail fast** with a clear error message (do not start the gateway)

### Interceptor registration (gateway startup)

The gateway loads the interceptor as a gRPC middleware:

```go
// Pseudocode (implementation in OpenShell gateway, not this repo)
if os.Getenv("OPENSHELL_HITLY_INTERCEPTOR_ENABLED") == "true" {
  hitlyConfig := loadHitlyInterceptorConfig()
  interceptor := NewHitlyInterceptor(hitlyConfig)
  grpcServer.Use(interceptor) // Register as unary interceptor
}
```

**Note:** The actual interceptor **implementation** is out of scope for `hitly-net/hitly`. This PR delivers:
1. **Design document** (this file)
2. **HITLy API endpoint** (`GET /api/v1/approvals?runId=...`)
3. **Reference interceptor stub** (TypeScript demo code in `examples/openshell/interceptor/`, NOT for production use in the OpenShell gateway)

The production interceptor will be implemented by the OpenShell team (likely in Go, as part of the OpenShell gateway codebase).

---

## 7. Out of Scope (This PR)

The following are explicitly **out of scope** for this draft PR:

### 7.1. Plugin HMAC / Resume Secret

The current design does NOT add HMAC-based resume secrets to `@hitly/plugin-openshell`. The plugin continues to use:

- **mTLS** for transport security (client cert + key)
- **Bearer token** for OpenShell API auth (`config:write` scope)
- **`review_token`** (provided by OpenShell in `GetDraftPolicy` response) for approval idempotency

**Why no HMAC?** The PM decision explicitly states:

> **no** HITLY_RESUME_SECRET / sign-only HMAC in plugin-openshell.

The interceptor is the defense-in-depth layer; the plugin does not change.

### 7.2. Cloud/GA Deployment

This PR is **OSS-only** (`hitly-net/hitly`). No changes to:

- Cloud invite-only configuration (`@hitly/cloud` package)
- Hosted HITLy deployment pipelines
- Stripe/billing entitlements
- SSO or team-level interceptor configuration

### 7.3. Production Gateway Integration

The production OpenShell gateway (Go, running on VM `openshell`) is out of scope. This PR delivers:

- **Design** (this document)
- **HITLy API** (query by `runId`)
- **Reference stub** (TypeScript demo in `examples/openshell/interceptor/`)

The OpenShell team will implement the production interceptor in Go as a gRPC middleware.

### 7.4. Sandbox Environment Secrets

Sandbox provisioning, secret injection, and CI/test environment configuration are out of scope. The interceptor is **disabled by default** and does not affect existing CI/test pipelines.

### 7.5. Bulk Approval Interception

`ApproveAllDraftChunks` is not intercepted in this PR. Future work may add batch verification (query HITLy for all chunks, verify all are decided).

### 7.6. Retry/Resume Flows

If a user clicks "Retry Resume" in HITLy (for `failed_resume` approvals), the interceptor allows the subsequent `ApproveDraftChunk`/`RejectDraftChunk` call (because the decision exists). The interceptor does not track retry counts or enforce "resume once only" semantics.

---

## 8. Implementation Plan

### Phase 1: Design (This PR)

1. ✅ Write this design document (`examples/openshell/docs/interceptor-design.md`)
2. ✅ Update PR description with summary and Ops deploy note

### Phase 2: HITLy API Endpoint (This PR, if time permits)

1. Add `GET /api/v1/approvals/by-run-id/route.ts` (or extend existing `/api/v1/approvals/route.ts` with `?runId=` query param)
2. Implement Postgres JSONB query: `WHERE origin->>'runId' = $1 AND plugin = $2 ORDER BY updatedAt DESC LIMIT 1`
3. Add tests for `by-run-id` endpoint (happy path, not found, auth)

### Phase 3: Reference Interceptor Stub (This PR, if time permits)

1. Create `examples/openshell/interceptor/` directory
2. Add TypeScript reference implementation:
   - `examples/openshell/interceptor/hitly-interceptor.ts` (gRPC middleware stub)
   - `examples/openshell/interceptor/hitly-client.ts` (HITLy API client)
   - `examples/openshell/interceptor/README.md` (usage guide for OpenShell team)
3. Add tests for interceptor logic (mocked HITLy API responses)

### Phase 4: Production Integration (Out of Scope, Ops)

1. OpenShell team implements Go-based interceptor in OpenShell gateway
2. Ops configures environment variables on production VM (`openshell`)
3. Deploy and verify with integration test (poller → HITLy → interceptor → OpenShell)

---

## 9. Testing Strategy

### 9.1. HITLy API Endpoint Tests

**File:** `apps/app/app/api/v1/approvals/by-run-id/route.test.ts`

Test cases:
1. **Happy path:** Query by `runId`, return matching approval
2. **Not found:** Query by non-existent `runId`, return 404
3. **Multiple approvals:** Query by `runId` with multiple approvals, return the **latest** by `updatedAt`
4. **Auth failure:** Query without API key, return 401
5. **Wrong project:** Query with API key for project B, return 404 for project A's approval

### 9.2. Interceptor Stub Tests

**File:** `examples/openshell/interceptor/hitly-interceptor.test.ts`

Test cases:
1. **Allow approve:** `ApproveDraftChunk` + HITLy decision `accept` → allow
2. **Deny approve mismatch:** `ApproveDraftChunk` + HITLy decision `reject` → deny
3. **Allow reject:** `RejectDraftChunk` + HITLy decision `reject` → allow
4. **Deny reject mismatch:** `RejectDraftChunk` + HITLy decision `accept` → deny
5. **Deny pending:** `ApproveDraftChunk` + HITLy status `pending` → deny
6. **Allow failed_resume:** `ApproveDraftChunk` + HITLy status `failed_resume` + decision `accept` → allow
7. **Deny not found:** `ApproveDraftChunk` + no HITLy approval → deny
8. **Deny HITLy unreachable (fail-closed):** `ApproveDraftChunk` + HITLy API timeout → deny
9. **Allow HITLy unreachable (fail-open):** `ApproveDraftChunk` + HITLy API timeout + `FAIL_OPEN=true` → allow (log warning)

### 9.3. Integration Test (Manual)

**Prerequisites:**
- OpenShell gateway with production interceptor (Go)
- HITLy app running on `http://localhost:3001`
- Poller running with valid config

**Steps:**
1. Trigger OpenShell agent to create a pending draft chunk
2. Poller ingests chunk → creates HITLy approval (status `pending`)
3. Attempt `ApproveDraftChunk` via gRPC → **denied** (interceptor: "approval is still pending")
4. Reviewer clicks **Accept** in HITLy inbox → approval status `decided`, decision `accept`
5. Retry `ApproveDraftChunk` via gRPC → **allowed** (interceptor: "decision matches")
6. Verify OpenShell policy version incremented

---

## 10. Operational Notes for Deployment

### 10.1. Production VM Configuration

**VM:** `openshell` (Tailscale `100.106.191.81`)  
**Gateway:** OpenShell 0.1.2, `https://127.0.0.1:17670` (loopback-only, mTLS)

**Required environment variables:**
```bash
# Interceptor (add to gateway startup script)
export OPENSHELL_HITLY_INTERCEPTOR_ENABLED=true
export OPENSHELL_HITLY_API_URL=http://localhost:3001
export OPENSHELL_HITLY_API_KEY=hitly_...   # Project API key (read-only)
export OPENSHELL_HITLY_PROJECT_ID=prj_...
export OPENSHELL_HITLY_INTERCEPTOR_TIMEOUT_MS=5000
export OPENSHELL_HITLY_INTERCEPTOR_FAIL_OPEN=false  # Fail-closed in production
```

**Secrets:**
- `OPENSHELL_HITLY_API_KEY` must be stored securely (e.g., Hashicorp Vault, AWS Secrets Manager)
- Do NOT commit API key to git or log it in plaintext

### 10.2. Rollout Plan

1. **Deploy HITLy API endpoint** (`GET /api/v1/approvals?runId=...`) to production VM
2. **Test endpoint** manually with `curl` (verify query by `runId` works)
3. **Deploy OpenShell gateway with interceptor** (Go implementation, not in this repo)
4. **Configure environment variables** on production VM (set `ENABLED=true`)
5. **Restart gateway** and verify interceptor is active (check logs: "HITLy interceptor enabled")
6. **Integration test:** Trigger pending chunk → deny without decision → approve in HITLy → allow
7. **Monitor:** Watch for `PERMISSION_DENIED` errors in gateway logs (indicates interceptor is blocking requests as expected)

### 10.3. Rollback Plan

If the interceptor causes issues:

1. **Disable interceptor:** Set `OPENSHELL_HITLY_INTERCEPTOR_ENABLED=false` and restart gateway
2. **Verify:** `ApproveDraftChunk` and `RejectDraftChunk` work without HITLy checks (mTLS only)
3. **Investigate:** Check HITLy API logs, interceptor logs, and gateway logs for errors

---

## 11. Open Questions (For PM/Derek)

1. **Multiple approvals for same chunk:** If a chunk is rejected, then re-submitted and approved, should the interceptor allow the second `ApproveDraftChunk`? (Current design: yes, it queries the **latest** approval by `updatedAt`)
2. **Interceptor ownership:** Should the reference stub be TypeScript (in this repo) or Go (in OpenShell repo)? (Current design: TypeScript stub in this repo for demo; Go implementation by OpenShell team)
3. **Fail-open for demo:** Should `FAIL_OPEN=true` be allowed, or should the interceptor always fail-closed? (Current design: allow `FAIL_OPEN=true` for demo/testing, but log a warning)
4. **API key rotation:** How should the interceptor's API key be rotated? (Out of scope for this PR; Ops will handle key rotation)

---

## 12. References

- **OpenShell proto:** `packages/plugin-openshell/proto/openshell.proto`
- **HITLy plugin:** `packages/plugin-openshell/src/index.ts`
- **HITLy approvals API:** `apps/app/app/api/v1/approvals/route.ts`
- **HITLy poller:** `examples/openshell/src/poller.ts`
- **PM decision:** GitHub issue or Slack thread (link TBD)

---

**End of Design Document**
