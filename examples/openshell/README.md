# OpenShell Origin Adapter for HITLy

**Demo-ready** OpenShell → HITLy integration for **human-in-the-loop approval of pending draft policy chunks**.

## Architecture (do not blur)

- **OpenShell** = enforce (sandbox policy / kernel isolation)
- **HITLy** = decide + evidence (inbox, signed resume, customer-owned sink)
- **NVIDIA Sentry** = silicon/out-of-band watchdog

This adapter is **not** a replacement for OpenShell TUI or Sentry. It handles only **pending drafts that need human review** (`human_review_required` / `proposal_approval_mode=manual`).

## Flow

```
OpenShell agent triggers human-review draft
  ↓
Poller: GetDraftPolicy(pending) → finds new chunk
  ↓
Poller: POST /api/v1/approvals → HITLy (idempotent by sandbox:chunkId)
  ↓
Reviewer decides in HITLy inbox
  ↓
HITLy: calls @hitly/plugin-openshell resume
  ↓
Plugin: ApproveDraftChunk or RejectDraftChunk (gRPC)
  ↓
Evidence: hitly.evidence.v1 signed receipt → configured sink
```

## Integration lock

1. **PRIMARY:** OpenShell public gRPC client
   - Ingest: `GetDraftPolicy` (polls per configured sandbox ID)
   - Decide: `ApproveDraftChunk` / `RejectDraftChunk`
   - Auth: Bearer token (passed in `authorization` header)

2. **Until** `WatchProposalInbox` / `ListProposalInbox` (NVIDIA #1612) ships: **poll `GetDraftPolicy` for `OPENSHELL_SANDBOX_IDS`**

3. **NOT** primary inbox path: Gateway Interceptors (optional `post_commit` audit fan-out later only)

4. **NOT:** Supervisor middleware, network-denial spam, or auto-apply

## Structure

| Path | Purpose |
| --- | --- |
| `packages/plugin-openshell/` | Plugin (resume logic: `ApproveDraftChunk` / `RejectDraftChunk`) |
| `examples/openshell/` | Poller (polls `GetDraftPolicy`, creates HITLy approvals) + demo |

## Prerequisites

1. **HITLy** running on `http://localhost:3001` (or cloud)
   - Project with plugin `openshell`
   - API key and project ID from Config tab

2. **OpenShell gateway** accessible via gRPC
   - Gateway address (e.g., `127.0.0.1:17670` for local mTLS, or `openshell.example.com:443`)
   - Bearer token with `config:read` and `config:write` scopes
   - **(Production)** TLS/mTLS certificates: CA cert, client cert, client key
   - **(Dev/test only)** Set `OPENSHELL_TLS_INSECURE=1` to disable TLS
   - Workspace name and sandbox ID(s)

3. **(Optional) Evidence sink** for `hitly.evidence.v1` events
   - Use `examples/evidence-http` on port 3100
   - Or omit to have HITLy log evidence only

## Setup

### 1. Install dependencies

From repo root:

```bash
yarn install
```

### 2. Configure environment

Copy `.env.example` to `.env` in `examples/openshell/`:

```bash
cd examples/openshell
cp .env.example .env
```

Edit `.env`:

```bash
# OpenShell
OPENSHELL_GATEWAY_ADDR=127.0.0.1:17670  # or your-gateway.example.com:443
OPENSHELL_BEARER_TOKEN=your_bearer_token
OPENSHELL_WORKSPACE=your-workspace
OPENSHELL_SANDBOX_IDS=sandbox-1,sandbox-2  # comma-separated

# OpenShell TLS/mTLS (production - required for live gateway)
# OPENSHELL_TLS_CA_FILE=/path/to/ca.pem
# OPENSHELL_TLS_CERT_FILE=/path/to/client-cert.pem
# OPENSHELL_TLS_KEY_FILE=/path/to/client-key.pem
# OPENSHELL_TLS_SSL_TARGET_NAME_OVERRIDE=openshell.local  # optional, for 127.0.0.1 with different cert CN

# OpenShell TLS (dev/test ONLY - do NOT use in production)
# OPENSHELL_TLS_INSECURE=1  # disables TLS for local testing

# HITLy
HITLY_API_URL=http://localhost:3001
HITLY_API_KEY=hitly_...
HITLY_PROJECT_ID=prj_...

# Polling
POLL_INTERVAL_MS=5000
```

**Never commit `.env` or API keys.**

**TLS/mTLS setup:**
- For production deployment on the OpenShell VM at 192.168.10.176, configure `OPENSHELL_TLS_*_FILE` paths to your CA, client cert, and client key.
- The gateway uses mTLS at `https://127.0.0.1:17670`. You may need `OPENSHELL_TLS_SSL_TARGET_NAME_OVERRIDE` if the cert CN doesn't match `127.0.0.1`.
- For local dev/testing without TLS, set `OPENSHELL_TLS_INSECURE=1`.

### 3. Start HITLy

From repo root:

```bash
yarn dev:app
```

HITLy runs on `http://localhost:3001`.

### 4. (Optional) Start evidence sink

```bash
cd examples/evidence-http
yarn start
```

Evidence sink runs on `http://localhost:3100`.

### 5. Run the poller

```bash
cd examples/openshell
yarn start
```

The poller will:
- Poll `GetDraftPolicy` for each sandbox in `OPENSHELL_SANDBOX_IDS` every 5 seconds
- Create HITLy approvals for new pending chunks (idempotent)
- HITLy calls `@hitly/plugin-openshell` resume on decision
- Plugin calls `ApproveDraftChunk` (accept) or `RejectDraftChunk` (reject)

## Demo mode

If you don't have a live OpenShell gateway:

```bash
yarn demo
```

Shows mock pending chunks and architecture explanation.

## How to record a walkthrough (Derek)

### Dependencies

1. **HITLy app**
   ```bash
   # Terminal 1: from repo root
   yarn dev:app
   ```

2. **Evidence sink** (optional)
   ```bash
   # Terminal 2: from repo root
   cd examples/evidence-http && yarn start
   ```

3. **Poller**
   ```bash
   # Terminal 3
   cd examples/openshell && yarn start
   ```

### Recording steps

1. **Trigger a human-review draft chunk**
   - Run an agent under OpenShell (OpenClaw or any agent)
   - Agent triggers `human_review_required` draft (e.g., outbound API call)
   - Poller detects within 5 seconds

2. **Show HITLy inbox**
   - Navigate to `http://localhost:3001/inbox`
   - New approval appears: `approve-openshell-draft-chunk`
   - Context shows: workspace, sandbox, chunk ID, proposed rule (protocol, destination, port), rationale, security notes

3. **Approve or reject**
   - Click **Accept** (or **Reject** with optional response)
   - HITLy calls `@hitly/plugin-openshell` resume
   - Plugin calls `ApproveDraftChunk` or `RejectDraftChunk`
   - Poller logs: "HITLy decided..."
   - Terminal shows gRPC result (policy version, hash, or error)

4. **Show OpenShell chunk status**
   - Use OpenShell CLI: `openshell draft list --sandbox <sandbox> --status approved` (or `rejected`)
   - Confirm chunk moved from `pending` → `approved`/`rejected`

5. **Show evidence**
   - Open `http://localhost:3100` (if using evidence sink)
   - Click approval ID
   - See event chain: `requested` → `decided` → `resumed` (or `resume_failed`)
   - Show integrity hashes linking events

## Acceptance criteria (issue #71)

- [x] Pending human-review chunks → HITLy approvals (idempotent by `sandbox:chunkId`)
- [x] Accept → `ApproveDraftChunk` + evidence
- [x] Reject → `RejectDraftChunk` + evidence
- [x] Fail-closed on gRPC decide failure (approval shows `failed_resume`)
- [x] Runnable demo + README
- [x] Tests with mocked gRPC for CI (`yarn test` in `packages/plugin-openshell`)

## Scope

**In scope:**
- Only `human_review_required` / `proposal_approval_mode=manual` pending drafts
- HITLy inbox as the primary decision surface
- `hitly.evidence.v1` signed receipts

**Out of scope:**
- Every network allow-list / denial ping (use OpenShell TUI)
- Replacing OpenShell TUI
- Gateway Interceptors as primary inbox (optional audit later)
- Supervisor middleware
- Auto-apply / reviewer-agent
- Cloud GA / invite-only changes (OSS `hitly-net/hitly` only)

## Env vars (production)

For production, align with OpenShell client docs:

```bash
OPENSHELL_GATEWAY_ADDR=           # gRPC endpoint (e.g., 127.0.0.1:17670)
OPENSHELL_BEARER_TOKEN=           # config:read + config:write
OPENSHELL_WORKSPACE=              # workspace name
OPENSHELL_SANDBOX_IDS=            # comma-separated until multi-inbox API

# TLS/mTLS (production - required for live gateway)
OPENSHELL_TLS_CA_FILE=            # path to CA certificate
OPENSHELL_TLS_CERT_FILE=          # path to client certificate
OPENSHELL_TLS_KEY_FILE=           # path to client private key
OPENSHELL_TLS_SSL_TARGET_NAME_OVERRIDE=  # optional: override hostname verification (e.g., openshell.local)

# TLS insecure mode (dev/test ONLY)
# OPENSHELL_TLS_INSECURE=1        # disable TLS (do NOT use in production)

HITLY_API_URL=                    # HITLy instance (routable, not localhost)
HITLY_API_KEY=                    # project API key
HITLY_PROJECT_ID=                 # project ID

POLL_INTERVAL_MS=5000             # default 5s
```

**TLS/mTLS:** Production deployment requires TLS certificates. The live OpenShell gateway at `https://127.0.0.1:17670` uses mTLS. Configure `OPENSHELL_TLS_*_FILE` paths to your CA, client cert, and client key. Use `OPENSHELL_TLS_INSECURE=1` only for local dev/testing.

## Troubleshooting

### "Missing required env var: OPENSHELL_GATEWAY_ADDR"

Create `.env` from `.env.example` and fill in all required variables.

### "HITLy createApproval failed (401)"

Check `HITLY_API_KEY`. Should start with `hitly_`.

### "GetDraftPolicy failed: UNAUTHENTICATED"

Check `OPENSHELL_BEARER_TOKEN`. Needs `config:read` scope.

### "ApproveDraftChunk failed: FAILED_PRECONDITION"

The `review_token` is stale (chunk was modified). This is expected; the approval is rejected to avoid approving out-of-date policy. The approval shows `failed_resume` in HITLy.

### No chunks appear

1. Verify poller logs: `[Poller] Sandbox X: N pending chunks`
2. Check OpenShell has pending chunks: `openshell draft list --sandbox <sandbox> --status pending`
3. Ensure `OPENSHELL_WORKSPACE` and `OPENSHELL_SANDBOX_IDS` match your actual workspace/sandboxes

## Testing

Plugin tests (mocked gRPC):

```bash
cd packages/plugin-openshell
yarn test
```

All 9 tests pass, covering:
- Ingest validation
- `ApproveDraftChunk` success/failure
- `RejectDraftChunk` success/failure
- Healthcheck

## License

Apache-2.0 (same as HITLy)

## References

- Issue: https://github.com/hitly-net/hitly/issues/71
- OpenShell proto: https://github.com/NVIDIA/OpenShell/blob/main/proto/openshell.proto
- HITLy integration guide: `/workspace/AGENT.md`
- Evidence spec: `examples/evidence-http/README.md`
