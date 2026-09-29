# HITLy Gateway Interceptor (Reference Implementation)

**STATUS:** **Optional Advanced Feature** (NOT part of primary demo path)

**IMPORTANT:** 
- This is a **TypeScript reference stub for demo purposes only**
- The production interceptor will be implemented in **Go** by the OpenShell team
- The interceptor is **disabled by default** and is **NOT required** for OpenShell→HITLy integration
- Primary Ops demo uses **mTLS + review_token only** (no interceptor)
- Enable the interceptor only if defense-in-depth verification is required

---

## Purpose

This directory contains a reference implementation of the HITLy gateway interceptor logic. It demonstrates:

1. **How to query HITLy** for approval status by `runId` (sandbox:chunkId)
2. **How to apply the decision matrix** (ApproveDraftChunk requires accept, RejectDraftChunk requires reject/cancel)
3. **How to handle fail-open vs fail-closed** modes
4. **How to configure the interceptor** via environment variables

---

## Files

| File | Purpose |
| --- | --- |
| `hitly-interceptor.ts` | Core interceptor logic (reference implementation) |
| `hitly-interceptor.test.ts` | Comprehensive test suite (demonstrates all decision matrix cases) |
| `README.md` | This file |

---

## How the Interceptor Works

### High-Level Flow

```
1. OpenShell plugin calls ApproveDraftChunk or RejectDraftChunk (gRPC)
   ↓
2. Interceptor extracts sandbox + chunkId from request
   ↓
3. Interceptor queries HITLy: GET /api/v1/approvals/by-run-id?runId=sandbox:chunkId&plugin=openshell
   ↓
4. Interceptor checks approval status and decision:
   - ApproveDraftChunk → requires HITLy decision "accept"
   - RejectDraftChunk → requires HITLy decision "reject" or "cancel"
   - Pending/expired/missing → deny
   ↓
5. Interceptor allows or denies the gRPC request
   - Allow: gRPC handler executes normally
   - Deny: gRPC returns PERMISSION_DENIED error
```

### Decision Matrix

See [../docs/interceptor-design.md](../docs/interceptor-design.md) section 5 for the full decision matrix.

**Summary:**

- **ApproveDraftChunk** + HITLy decision `accept` → ✅ Allow
- **ApproveDraftChunk** + HITLy decision `reject` → ❌ Deny (mismatch)
- **RejectDraftChunk** + HITLy decision `reject` or `cancel` → ✅ Allow
- **RejectDraftChunk** + HITLy decision `accept` → ❌ Deny (mismatch)
- **Any method** + HITLy status `pending` → ❌ Deny (awaiting human)
- **Any method** + HITLy API unreachable → ❌ Deny (fail-closed) or ✅ Allow (fail-open, demo only)

---

## Configuration (Advanced/Optional)

**Note:** The interceptor is **disabled by default**. Do not enable it unless defense-in-depth verification is required for your security policy.

The interceptor is configured via environment variables:

```bash
# Enable interceptor (default: false)
OPENSHELL_HITLY_INTERCEPTOR_ENABLED=true

# HITLy API URL (required if enabled)
OPENSHELL_HITLY_API_URL=http://localhost:3001

# HITLy project API key (required if enabled, must start with "hitly_")
OPENSHELL_HITLY_API_KEY=hitly_...

# HITLy project ID (required if enabled, must start with "prj_")
OPENSHELL_HITLY_PROJECT_ID=prj_...

# Request timeout for HITLy API calls (default: 5000ms)
OPENSHELL_HITLY_INTERCEPTOR_TIMEOUT_MS=5000

# Fail-open mode (default: false, set to "true" ONLY for testing/demo)
# If true, allow requests even if HITLy API is unreachable (NOT FOR PRODUCTION)
OPENSHELL_HITLY_INTERCEPTOR_FAIL_OPEN=false
```

### Fail-Closed vs Fail-Open

- **Fail-closed (default, `FAIL_OPEN=false`):** If HITLy API is unreachable, **deny** the request. This ensures human-in-the-loop enforcement is not silently bypassed.
- **Fail-open (`FAIL_OPEN=true`):** If HITLy API is unreachable, **allow** the request (log a warning). This mode is for demo/testing only and should **never** be used in production.

---

## Running Tests

```bash
cd examples/openshell/interceptor
yarn test
```

All tests should pass. They demonstrate:

- Config validation
- Disabled interceptor (no-op)
- ApproveDraftChunk + accept → allow
- ApproveDraftChunk + reject → deny (mismatch)
- RejectDraftChunk + reject/cancel → allow
- RejectDraftChunk + accept → deny (mismatch)
- Pending approvals → deny
- Failed resume → allow (decision exists)
- Expired approvals → deny
- Cancelled approvals → deny
- Missing approvals → deny
- HITLy API timeout → deny
- Fail-open mode → allow on error

---

## Production Integration (Go Implementation)

The OpenShell team will implement the production interceptor in **Go** as a gRPC middleware. This TypeScript stub serves as a reference for the logic.

### Go Interceptor Pseudocode

```go
package interceptor

import (
    "context"
    "fmt"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

type HitlyInterceptor struct {
    enabled      bool
    hitlyClient  *HitlyClient
    failOpen     bool
}

func (i *HitlyInterceptor) UnaryInterceptor(
    ctx context.Context,
    req interface{},
    info *grpc.UnaryServerInfo,
    handler grpc.UnaryHandler,
) (interface{}, error) {
    if !i.enabled {
        return handler(ctx, req)
    }

    // Only intercept ApproveDraftChunk and RejectDraftChunk
    if info.FullMethod != "/openshell.v1.OpenShell/ApproveDraftChunk" &&
       info.FullMethod != "/openshell.v1.OpenShell/RejectDraftChunk" {
        return handler(ctx, req)
    }

    // Extract sandbox and chunkId from request
    sandbox, chunkId, err := extractSandboxAndChunkId(req)
    if err != nil {
        return nil, status.Errorf(codes.InvalidArgument, "failed to extract sandbox/chunkId: %v", err)
    }

    runId := fmt.Sprintf("%s:%s", sandbox, chunkId)

    // Query HITLy for approval status
    approval, err := i.hitlyClient.QueryApproval(ctx, runId)
    if err != nil {
        if i.failOpen {
            log.Warnf("[HITLy Interceptor] FAIL-OPEN: Allowing request despite error: %v", err)
            return handler(ctx, req)
        }
        return nil, status.Errorf(codes.PermissionDenied, "HITLy API unreachable (fail-closed): %v", err)
    }

    if approval == nil {
        return nil, status.Errorf(codes.PermissionDenied, "HITLy approval required: no approval found for runId %s", runId)
    }

    // Apply decision matrix
    allowed, reason := applyDecisionMatrix(info.FullMethod, approval)
    if !allowed {
        return nil, status.Errorf(codes.PermissionDenied, "HITLy approval required: %s", reason)
    }

    // Allow request
    return handler(ctx, req)
}

func applyDecisionMatrix(method string, approval *Approval) (bool, string) {
    if approval.Status == "pending" {
        return false, fmt.Sprintf("approval %s is still pending (awaiting human decision)", approval.Id)
    }

    if approval.Status == "expired" {
        return false, fmt.Sprintf("approval %s has expired", approval.Id)
    }

    if approval.Status == "cancelled" && approval.Decision != "cancel" {
        return false, fmt.Sprintf("approval %s was cancelled without a decision", approval.Id)
    }

    if approval.Status == "decided" || approval.Status == "failed_resume" {
        if method == "/openshell.v1.OpenShell/ApproveDraftChunk" {
            if approval.Decision == "accept" {
                return true, ""
            }
            return false, fmt.Sprintf("decision mismatch: HITLy decision is %q, but gRPC method is ApproveDraftChunk (requires \"accept\")", approval.Decision)
        } else if method == "/openshell.v1.OpenShell/RejectDraftChunk" {
            if approval.Decision == "reject" || approval.Decision == "cancel" {
                return true, ""
            }
            return false, fmt.Sprintf("decision mismatch: HITLy decision is %q, but gRPC method is RejectDraftChunk (requires \"reject\" or \"cancel\")", approval.Decision)
        }
    }

    return false, fmt.Sprintf("unknown approval status: %s", approval.Status)
}
```

### HITLy Client (Go)

```go
package interceptor

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

type HitlyClient struct {
    apiUrl     string
    apiKey     string
    projectId  string
    httpClient *http.Client
}

type Approval struct {
    Id       string  `json:"id"`
    Status   string  `json:"status"`
    Decision *string `json:"decision,omitempty"`
    RunId    string  `json:"runId"`
}

func (c *HitlyClient) QueryApproval(ctx context.Context, runId string) (*Approval, error) {
    url := fmt.Sprintf("%s/api/v1/approvals/by-run-id?runId=%s&plugin=openshell", c.apiUrl, runId)

    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return nil, err
    }

    req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.apiKey))
    req.Header.Set("Content-Type", "application/json")

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    if resp.StatusCode == 404 {
        return nil, nil // No approval found
    }

    if resp.StatusCode != 200 {
        return nil, fmt.Errorf("HITLy API error: %d", resp.StatusCode)
    }

    var approval Approval
    if err := json.NewDecoder(resp.Body).Decode(&approval); err != nil {
        return nil, err
    }

    return &approval, nil
}
```

---

## Testing the Reference Stub (Local)

1. **Start HITLy app:**
   ```bash
   cd /workspace
   yarn dev:app
   ```

2. **Start OpenShell poller:**
   ```bash
   cd examples/openshell
   yarn start
   ```

3. **Trigger a pending chunk** (via OpenShell agent)

4. **Test interceptor logic** (mocked):
   ```bash
   cd examples/openshell/interceptor
   yarn test
   ```

---

## Security Notes

1. **API key permissions:** The interceptor's HITLy API key should be **read-only** (can query `GET /api/v1/approvals/by-run-id`, but cannot decide or create approvals).
2. **Fail-closed by default:** Never set `FAIL_OPEN=true` in production. If HITLy is unreachable, policy changes should be blocked.
3. **Secrets management:** Store `OPENSHELL_HITLY_API_KEY` securely (Vault, AWS Secrets Manager, etc.). Do not commit to git or log in plaintext.

---

## References

- **Design document:** [../docs/interceptor-design.md](../docs/interceptor-design.md)
- **HITLy API:** `apps/app/app/api/v1/approvals/by-run-id/route.ts`
- **HITLy plugin:** `packages/plugin-openshell/src/index.ts`
- **OpenShell proto:** `packages/plugin-openshell/proto/openshell.proto`

---

**For questions, contact Derek/PM or the HITLy team.**
