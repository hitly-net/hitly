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
   - **Production:** OpenShell 0.1.2 on VM `openshell` (Tailscale `100.106.191.81`)
     - `auth_mode=mtls`, loopback ONLY at `https://127.0.0.1:17670`
     - **IMPORTANT:** Gateway is loopback-only by design for security. Do NOT weaken mTLS or bind port 17670 off loopback.
     - Client certificates live under `~/.config/openshell/gateways/openshell/mtls/` on the VM
   - Bearer token with `config:read` and `config:write` scopes (optional with mTLS)
   - Workspace name and sandbox ID(s)
   - **Dev/test only:** Set `OPENSHELL_TLS_INSECURE=1` to disable TLS (explicit opt-in)

3. **(Optional) Evidence sink** for `hitly.evidence.v1` events
   - Use `examples/evidence-http` on port 3100
   - Or omit to have HITLy log evidence only

## Production deployment (VM openshell)

**Infrastructure:**
- VM: `openshell` (Tailscale `100.106.191.81`)
- OpenShell: version 0.1.2
- Gateway: `https://127.0.0.1:17670` (loopback-only, `auth_mode=mtls`)
- HITLy: co-located on same VM (port 3001)
- Evidence HTTP: co-located on same VM (port 3100)

**Security constraints:**
- Gateway is **loopback-only** by design for security
- **Do NOT** weaken mTLS (keep `auth_mode=mtls`)
- **Do NOT** bind port 17670 off loopback (e.g., `0.0.0.0:17670`)
- Client certificates are pre-provisioned under `~/.config/openshell/gateways/openshell/mtls/`
- Point env vars to certificate paths; **NEVER commit or paste PEMs/secrets**

**Deployment status:**
- Poller deployment is **blocked** until this PR lands
- Ops will wire production configuration after branch merges
- Cloud invite-only setup remains unchanged

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
# OpenShell (production on VM openshell / Tailscale 100.106.191.81)
OPENSHELL_GATEWAY_ADDR=127.0.0.1:17670  # loopback-only mTLS gateway
OPENSHELL_BEARER_TOKEN=your_bearer_token  # optional with mTLS
OPENSHELL_WORKSPACE=your-workspace
OPENSHELL_SANDBOX_IDS=sandbox-1,sandbox-2  # comma-separated

# OpenShell TLS/mTLS (REQUIRED for production)
# Client certs live under ~/.config/openshell/gateways/openshell/mtls/ on the VM
# Point env vars to those paths. NEVER commit or paste PEMs/secrets.
OPENSHELL_TLS_CA_FILE=$HOME/.config/openshell/gateways/openshell/mtls/ca.pem
OPENSHELL_TLS_CERT_FILE=$HOME/.config/openshell/gateways/openshell/mtls/client-cert.pem
OPENSHELL_TLS_KEY_FILE=$HOME/.config/openshell/gateways/openshell/mtls/client-key.pem

# Optional: if cert CN != 127.0.0.1
# OPENSHELL_TLS_SSL_TARGET_NAME_OVERRIDE=openshell.local

# OpenShell TLS (dev/test ONLY - NEVER use in production)
# OPENSHELL_TLS_INSECURE=1  # disables TLS for local testing

# HITLy
HITLY_API_URL=http://localhost:3001
HITLY_API_KEY=hitly_...
HITLY_PROJECT_ID=prj_...

# Polling
POLL_INTERVAL_MS=5000
```

**Never commit `.env` or API keys.**

**Production deployment (VM openshell):**
- OpenShell 0.1.2 gateway runs at loopback-only `https://127.0.0.1:17670` with `auth_mode=mtls`
- **Security:** Gateway is loopback-only by design. Do NOT weaken mTLS or bind port 17670 off loopback.
- Client certificates are pre-provisioned under `~/.config/openshell/gateways/openshell/mtls/` on the VM
- Point `OPENSHELL_TLS_*_FILE` env vars to those paths (shown above)
- Poller will be deployed after this PR lands (Ops-managed)

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
- TLS/mTLS support for production gateway (OpenShell 0.1.2, `auth_mode=mtls`)

**Out of scope:**
- Every network allow-list / denial ping (use OpenShell TUI)
- Replacing OpenShell TUI
- Gateway Interceptors as primary inbox (optional audit later)
- Supervisor middleware
- Auto-apply / reviewer-agent
- Cloud GA / invite-only changes (OSS `hitly-net/hitly` only)
- Weakening mTLS or binding port 17670 off loopback (security constraint)

## Env vars (production)

Production deployment on VM `openshell` (Tailscale `100.106.191.81`):

```bash
# OpenShell Gateway (OpenShell 0.1.2, auth_mode=mtls, loopback-only)
OPENSHELL_GATEWAY_ADDR=127.0.0.1:17670  # loopback-only by design for security
OPENSHELL_BEARER_TOKEN=                 # config:read + config:write (optional with mTLS)
OPENSHELL_WORKSPACE=                    # workspace name
OPENSHELL_SANDBOX_IDS=                  # comma-separated until multi-inbox API

# TLS/mTLS (REQUIRED for production - client certs under ~/.config/openshell/gateways/openshell/mtls/)
OPENSHELL_TLS_CA_FILE=$HOME/.config/openshell/gateways/openshell/mtls/ca.pem
OPENSHELL_TLS_CERT_FILE=$HOME/.config/openshell/gateways/openshell/mtls/client-cert.pem
OPENSHELL_TLS_KEY_FILE=$HOME/.config/openshell/gateways/openshell/mtls/client-key.pem

# Optional: override hostname verification (e.g., if cert CN != 127.0.0.1)
# OPENSHELL_TLS_SSL_TARGET_NAME_OVERRIDE=openshell.local

# TLS insecure mode (dev/test ONLY - NEVER use in production)
# OPENSHELL_TLS_INSECURE=1

# HITLy
HITLY_API_URL=                          # HITLy instance (http://localhost:3001 for co-located)
HITLY_API_KEY=                          # project API key
HITLY_PROJECT_ID=                       # project ID

# Polling
POLL_INTERVAL_MS=5000                   # default 5s
```

**Security notes:**
- Gateway is loopback-only (`127.0.0.1:17670`) by design. Do NOT weaken mTLS or bind port 17670 off loopback.
- Client certificates are pre-provisioned on the VM under `~/.config/openshell/gateways/openshell/mtls/`
- Point `OPENSHELL_TLS_*_FILE` to those paths; NEVER commit or paste PEMs/secrets
- Bearer token is optional when using mTLS (gateway `auth_mode=mtls`)
- Insecure mode (`OPENSHELL_TLS_INSECURE=1`) is for dev/test only with explicit opt-in

**Deployment:**
- Poller deployment is blocked until this PR lands
- Ops will wire production config after branch merges

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
