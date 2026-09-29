# OpenShell Origin Adapter for HITLy

**Demo-ready** OpenShell → HITLy integration for **human-in-the-loop approval of pending draft policy chunks**.

## Architecture (do not blur)

- **OpenShell** = enforce (sandbox policy / kernel isolation)
- **HITLy** = decide + evidence (inbox, signed resume, customer-owned sink)
- **NVIDIA Sentry** = silicon/out-of-band watchdog

This adapter is **not** a replacement for OpenShell TUI or Sentry. It handles only **pending drafts that need human review** (`human_review_required` / `proposal_approval_mode=manual`).

## Flow (Synchronous)

The **synchronous demo** flow where a network request blocks and resumes:

```
Agent inside OpenShell sandbox runs: curl https://api.anthropic.com
  ↓
OpenShell: blocks connection, creates draft chunk (human_review_required)
  ↓  [curl waits, connection held open]
Poller: GetDraftPolicy(pending) → finds new chunk (within 5s)
  ↓
Poller: POST /api/v1/approvals → HITLy (idempotent by sandbox:chunkId)
  ↓  [curl still waiting]
Reviewer decides in HITLy inbox
  ↓
HITLy: calls @hitly/plugin-openshell resume
  ↓
Plugin: ApproveDraftChunk or RejectDraftChunk (gRPC)
  ↓
OpenShell: releases held connection → curl completes (same request!)
  ↓
Evidence: hitly.evidence.v1 signed receipt → configured sink
```

**Key difference from async:**
- Async: request denied → approval created → human decides → **retry** request → success
- **Sync (this demo):** request **blocks** → approval created → human decides → **same request** completes

## Integration lock

1. **PRIMARY:** OpenShell public gRPC client + **mTLS + review_token**
   - Ingest: `GetDraftPolicy` (polls per configured sandbox ID)
   - Decide: `ApproveDraftChunk` / `RejectDraftChunk`
   - Auth: mTLS client certificates + Bearer token (optional with mTLS)
   - **Demo uses this path exclusively** (no interceptor required)

2. **Until** `WatchProposalInbox` / `ListProposalInbox` (NVIDIA #1612) ships: **poll `GetDraftPolicy` for `OPENSHELL_SANDBOX_IDS`**

3. **NOT required for demo:** Gateway Interceptors
   - Optional **advanced** defense-in-depth feature
   - See `docs/interceptor-design.md` for advanced users
   - **Disabled by default**, **NOT part of primary demo path**
   - Primary security: mTLS + review_token only

4. **NOT:** Supervisor middleware, network-denial spam, or auto-apply

## Structure

| Path | Purpose |
| --- | --- |
| `packages/plugin-openshell/` | Plugin (resume logic: `ApproveDraftChunk` / `RejectDraftChunk`) |
| `examples/openshell/` | Poller (polls `GetDraftPolicy`, creates HITLy approvals) + demo |
| `examples/openshell/trigger-sync-demo.sh` | **Helper script:** Run inside sandbox to trigger synchronous blocking demo |
| `examples/openshell/docs/` | **Advanced:** Gateway interceptor design (optional, not required for primary demo) |
| `examples/openshell/interceptor/` | **Advanced:** Reference interceptor stub (disabled by default) |

**Note:** The gateway interceptor (`docs/interceptor-design.md`) is an **optional advanced feature** for defense-in-depth verification. It is **NOT** part of the primary OpenShell→HITLy demo path. The default integration uses **mTLS + review_token** only.

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

**Ops follow-up after PR merge:**
- Refresh demo scripts on production VM from this branch
- Verify sandbox is configured for **blocking/synchronous human-review mode**
  - Check: `openshell sandbox get <sandbox-id>` or gateway admin console
  - Expected: network requests **wait** for approval (not immediate deny)
  - If synchronous mode is not default, configure: `proposal_approval_mode=blocking` or equivalent
- Test `trigger-sync-demo.sh` inside the sandbox to confirm blocking behavior
- Update internal demo runbook with new synchronous flow instructions

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

## How to record a synchronous demo (Derek)

### Goal

Demonstrate **synchronous** OpenShell→HITLy flow where a single network request:
1. **Blocks** at the OpenShell policy wall
2. **Waits** while human reviews in HITLy inbox
3. **Resumes** with the same in-flight request showing stdout

**Not** the async pattern of: propose → exit → re-run after accept.

### Architecture

- **mTLS + review_token** is the primary path (interceptor is optional/advanced, OFF for this demo)
- OpenShell holds the agent's network connection open while the draft chunk is pending
- Poller detects draft and creates HITLy approval (within 5 seconds)
- Human decides in HITLy inbox → HITLy calls plugin → OpenShell releases connection
- **Same request** completes (success) or fails (reject) without retry

### Prerequisites

1. **OpenShell sandbox running** with human-review mode enabled
   - Sandbox must be configured to **hold connections** during human review (not deny immediately)
   - Example: `proposal_approval_mode=blocking` or similar runtime setting
   - Check with: `openshell sandbox get <sandbox-id>` or gateway admin

2. **HITLy app running**
   ```bash
   # Terminal 1: from repo root
   yarn dev:app
   ```

3. **Evidence sink (optional)**
   ```bash
   # Terminal 2: from repo root
   cd examples/evidence-http && yarn start
   ```

4. **Poller running**
   ```bash
   # Terminal 3: from repo root
   cd examples/openshell && yarn start
   ```

### Recording steps (synchronous flow)

#### Option A: Using the helper script (recommended)

**Terminal 4: Inside OpenShell sandbox**

```bash
# Copy the helper script into the sandbox (if not already there)
# Then run:
./trigger-sync-demo.sh https://api.anthropic.com/v1/models

# OR: let it use the default URL
./trigger-sync-demo.sh
```

The script will:
- Verify it's running inside a sandbox (warns if not)
- Display expected flow and demo tips
- Run curl with verbose output to show blocking
- Measure duration (helpful for showing it waited for human decision)
- Display success/failure summary

**Expected output (while blocking):**

```
=== OpenShell HITLy Synchronous Demo ===

Demo URL: https://api.anthropic.com/v1/models
Sandbox:  sandbox-demo-123
Workspace: demo-workspace

Expected flow:
  1. This curl will BLOCK (not fail immediately)
  2. OpenShell creates draft chunk (human_review_required)
  3. Poller detects chunk and creates HITLy approval (within 5s)
  4. Human reviews in HITLy inbox: http://localhost:3001/inbox
  5. Accept → this curl completes with response
     Reject → this curl fails with policy error

📹 Recording tip: Keep this terminal visible while reviewing in HITLy

Starting synchronous request...

[2026-09-29T13:55:00+00:00] Request started (blocking mode)

* Trying 1.2.3.4:443...
* Connected to api.anthropic.com (1.2.3.4) port 443
... [curl waits here - no output until HITLy decision] ...
```

#### Option B: Manual curl (also works)

**Terminal 4: Inside OpenShell sandbox**

Run any network request that requires human approval:

```bash
# Example: curl to external API that requires human approval
curl -v https://api.anthropic.com/v1/models

# OR: any agent command that triggers network policy review
# Example: Python script, npm install, git clone, etc.
```

**Expected behavior:**
- Command **blocks** (no immediate error)
- OpenShell creates a draft chunk with `human_review_required`
- Connection stays open, waiting for policy decision

#### Terminal 3: Watch poller logs

Poller detects the draft within 5 seconds:

```
[Poller] Sandbox <sandbox>: 1 pending chunks
[Poller] New pending chunk: chunk_abc123 in <sandbox>
[HITLy] Created approval appr_xyz789 for chunk chunk_abc123
```

#### Browser: HITLy inbox

1. Navigate to `http://localhost:3001/inbox`
2. See new approval: `approve-openshell-draft-chunk`
3. Review context:
   - **Destination:** `https://api.anthropic.com` (or actual URL)
   - **Rationale:** Agent observed repeated connection attempts
   - **Security Notes:** External API access, credentials may be sent

#### Browser: Accept or Reject

**To demonstrate Accept:**
- Click **Accept**
- HITLy calls `ApproveDraftChunk`
- OpenShell approves the chunk and **releases the held connection**

**Terminal 4 (sandbox):** The original curl completes immediately with API response:

```json
{
  "models": [...]
}
```

If using `trigger-sync-demo.sh`, you'll also see:

```
[2026-09-29T13:55:42+00:00] Request completed (exit code: 0)
Duration: 42s

✅ SUCCESS: Request completed after human approval
   Demo showed: blocked → HITLy inbox → accept → same request completed
```

**To demonstrate Reject:**
- Click **Reject** with optional reason (e.g., "Demo rejection")
- HITLy calls `RejectDraftChunk`
- OpenShell rejects the chunk and **fails the held connection**

**Terminal 4 (sandbox):** The original curl fails immediately:

```
curl: (7) Failed to connect: Connection refused (policy rejected)
```

Or similar OpenShell policy error (exact message depends on OpenShell version).

If using `trigger-sync-demo.sh`, you'll see:

```
[2026-09-29T13:56:15+00:00] Request completed (exit code: 7)
Duration: 33s

❌ FAILED: Request rejected or errored (exit code: 7)
   Possible causes:
   - Human rejected in HITLy (expected for reject demo)
   ...
```

#### Demo narrative

**Key points for recording:**

1. **Blocked state:** Show terminal with curl paused (no output, waiting)
2. **HITLy inbox:** Show approval card with context
3. **Accept action:** Click Accept in HITLy
4. **Same curl completes:** Terminal 4 shows stdout from the **same command** (not a retry)

**Contrast with async (not shown):**
- Async: curl fails immediately → poller creates approval → human accepts → **re-run curl** → success
- **Sync (this demo):** curl waits → poller creates approval → human accepts → **same curl** completes

### Troubleshooting synchronous demo

**"My curl fails immediately instead of blocking"**

Sandbox is configured for immediate deny, not blocking mode. Check:
- Sandbox runtime settings: `openshell sandbox get <sandbox-id>`
- Look for `proposal_approval_mode` or similar setting
- Expected: mode that **holds connections** during human review (not immediate deny)
- Contact OpenShell admin to enable blocking/synchronous approval mode

**"Poller doesn't detect the chunk"**

- Verify `OPENSHELL_SANDBOX_IDS` includes the sandbox you're testing in
- Check poller is running: Terminal 3 should show poll logs every 5 seconds
- Manually verify chunk exists: `openshell draft list --sandbox <sandbox> --status pending`

**"HITLy shows approval but curl still hangs"**

- Check Terminal 3 (poller) for resume errors
- Look for: `ApproveDraftChunk failed: FAILED_PRECONDITION` (stale review_token)
- Check plugin credentials in HITLy project Config tab (mTLS certs, bearer token)

**"Curl completes but I didn't see HITLy inbox"**

- Policy may have been auto-approved (not in human-review mode)
- Check sandbox settings for `proposal_approval_mode=manual` or `human_review_required`

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
- Gateway Interceptors as primary inbox (optional **advanced** feature in `docs/interceptor-design.md`, disabled by default)
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
- **Ops must verify sandbox blocking mode** for synchronous demo (see "Ops follow-up" above)

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
