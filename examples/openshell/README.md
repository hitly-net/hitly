# OpenShell Origin Adapter for HITLy

**Demo-ready** OpenShell → HITLy integration for **human-in-the-loop approval of pending draft policy chunks**.

## Architecture (do not blur)

- **OpenShell** = enforce (sandbox policy / kernel isolation)
- **HITLy** = decide + evidence (inbox, signed resume, customer-owned sink)
- **NVIDIA Sentry** = silicon/out-of-band watchdog

This adapter is **not** a replacement for OpenShell TUI or Sentry. It handles only **pending drafts that need human review** (`human_review_required` / `proposal_approval_mode=manual`).

## Flow (Async on OpenShell 0.1.2)

The **async demo** flow on OpenShell 0.1.2 (fail-fast):

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
| `examples/openshell/trigger-async-demo.sh` | **Helper script:** Run inside sandbox to trigger async demo (fail-fast + retry) |
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
- **Install curl in sandbox image** (0.1.2 default image missing `/usr/bin/curl`)
- Verify sandbox configured for `proposal_approval_mode=manual` (human-review mode)
  - Check: `openshell sandbox get <sandbox-id>` or gateway admin console
  - **Note:** No "blocking" mode on 0.1.2; only `manual` or `auto`
- Test `trigger-async-demo.sh` inside the sandbox:
  - Run script → Permission denied (fail-fast) + draft created
  - Accept in HITLy → retry script → succeeds
- Update internal demo runbook with **async flow** (fail-fast + retry after Accept)

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

## How to record an async demo (Derek) — OpenShell 0.1.2

### Goal

Demonstrate **async** OpenShell→HITLy flow on OpenShell 0.1.2 where:
1. Network request **fails immediately** (Permission denied, fail-fast)
2. Draft chunk created for HITLy review
3. Human reviews and decides in HITLy inbox
4. Policy updated by HITLy
5. **Retry** the request → succeeds (policy now allows)

**Preferred long-term product story** (requires future OpenShell held-connection feature):
- In-flight request blocks → HITLy Accept → same request completes (no retry)
- When available, update docs to emphasize sync resume
- For now: **async flow is the honest, working path on 0.1.2**

### Architecture

- **mTLS + review_token** is the primary path (interceptor is optional/advanced, OFF for this demo)
- Poller detects draft and creates HITLy approval (within 5 seconds)
- Human decides in HITLy inbox → HITLy calls plugin → policy updated
- **Preferred long-term product story:** In-flight request blocks → HITLy decide → same request completes
  - This requires OpenShell feature to **hold** denied connections (not available on 0.1.2)

### ⚠️ Known Limitations (OpenShell 0.1.2) — Ops Verified

**Synchronous resume FAILS on OpenShell 0.1.2.** The gateway is **fail-fast**, not blocking.

**Ops probe confirmed (OpenShell 0.1.2):**

1. **Denied TCP is fail-fast:** `Permission denied` (~0s) + pending draft created
2. **Accept does NOT resume** that failed socket
3. **No "blocking" approval mode** — only `manual` or `auto` (any docs mentioning `proposal_approval_mode=blocking` are wrong)
4. **Working path on 0.1.2:** Async propose + retry after Accept

**Actual 0.1.2 flow:**

```
Agent runs curl → Permission denied (fail-fast) + draft chunk created
  ↓ [curl exits immediately with error]
Poller detects draft (within 5s) → HITLy approval created
  ↓
Human reviews in HITLy inbox → Accept
  ↓
HITLy calls ApproveDraftChunk → policy updated
  ↓
Operator re-runs curl → succeeds (policy now allows)
```

**Demo narrative for 0.1.2:**

- **Honest:** "Request denied → draft in HITLy → Accept → policy approved → retry succeeds"
- **NOT:** "Request blocks → Accept → same request completes" (sync resume not available)
- Emphasize: HITLy approval and policy update work correctly; held-connection resume is future OpenShell feature

**Preferred long-term story** (requires OpenShell held-connection feature):
- In-flight request blocks → HITLy Accept → same request completes (no retry)
- When OpenShell supports this, update docs and demo narrative accordingly

### Prerequisites

1. **OpenShell sandbox running** with human-review mode enabled
   - Sandbox configured for `proposal_approval_mode=manual`
   - Check with: `openshell sandbox get <sandbox-id>` or gateway admin
   - **Note:** OpenShell 0.1.2 is fail-fast (not blocking); requests denied immediately

2. **curl installed in sandbox** (OpenShell 0.1.2 default image missing `/usr/bin/curl`)
   - Ops prerequisite: install curl in sandbox image before demo
   - Alternative: use `/dev/tcp` or other built-in tools (see script comments)

3. **HITLy app running**
   ```bash
   # Terminal 1: from repo root
   yarn dev:app
   ```

4. **Evidence sink (optional)**
   ```bash
   # Terminal 2: from repo root
   cd examples/evidence-http && yarn start
   ```

5. **Poller running**
   ```bash
   # Terminal 3: from repo root
   cd examples/openshell && yarn start
   ```

### Recording steps (async flow on OpenShell 0.1.2)

#### Option A: Using the helper script (recommended)

**Terminal 4: Inside OpenShell sandbox**

```bash
# Copy the helper script into the sandbox (if not already there)
# Then run:
./trigger-async-demo.sh https://api.anthropic.com/v1/models

# OR: let it use the default URL
./trigger-async-demo.sh
```

The script will:
- Verify it's running inside a sandbox (warns if not)
- Check for curl (errors if missing, shows workaround)
- Display expected flow (fail-fast on 0.1.2)
- Run curl (fails immediately with Permission denied)
- Guide user to Accept in HITLy and retry

**Expected output (OpenShell 0.1.2 fail-fast):**

```
=== OpenShell HITLy Async Demo (0.1.2) ===

⚠️  OpenShell 0.1.2 is FAIL-FAST (Ops verified):
   - Request will be DENIED immediately (Permission denied ~0s)
   - Draft chunk created for HITLy review
   - After Accept, RE-RUN this script (retry)

Demo URL: https://api.anthropic.com/v1/models
Sandbox:  sandbox-demo-123
Workspace: demo-workspace

Expected flow (0.1.2 fail-fast):
  1. This curl will FAIL immediately (Permission denied)
  2. OpenShell creates draft chunk (human_review_required)
  3. Poller detects chunk and creates HITLy approval (within 5s)
  4. Human reviews in HITLy inbox
  5. Accept → policy approved
  6. RE-RUN this script → succeeds (policy now allows)

Starting request (expect fail-fast on first run)...

curl: (7) Failed to connect: Permission denied

[Request failed as expected - draft created]
Check HITLy inbox: http://localhost:3001/inbox
After Accept, re-run: ./trigger-async-demo.sh
```

#### Option B: Manual curl (also works)

**Terminal 4: Inside OpenShell sandbox**

Run any network request that requires human approval:

```bash
# Example: curl to external API (requires curl installed in sandbox)
curl -v https://api.anthropic.com/v1/models

# Expected: Permission denied (fail-fast)
# Then check HITLy inbox, Accept, and re-run curl
```

**Expected behavior (OpenShell 0.1.2):**
- Command **fails immediately** (Permission denied ~0s)
- OpenShell creates a draft chunk with `human_review_required`
- No blocking wait; curl exits with error

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
- Click **Accept** in HITLy inbox
- HITLy calls `ApproveDraftChunk`
- OpenShell approves the chunk and updates policy

**Terminal 4 (sandbox) — OpenShell 0.1.2:**

The original curl has **already failed** (exit code 7, Permission denied ~0s).

**Re-run the request:**

```bash
./trigger-async-demo.sh https://api.anthropic.com/v1/models
# OR: curl -v https://api.anthropic.com/v1/models
```

**Retry succeeds:**

```json
{
  "models": [...]
}
```

**Demo narrative for 0.1.2:**
- "Request denied → draft in HITLy → Accept → policy approved → retry succeeds"
- "On OpenShell 0.1.2, requests are fail-fast; after approval, re-run the command"
- "Future OpenShell versions may support held-connection resume (same request completes)"

**To demonstrate Reject:**
- Click **Reject** with optional reason (e.g., "Demo rejection")
- HITLy calls `RejectDraftChunk`
- OpenShell rejects the chunk

**Terminal 4 (sandbox) — OpenShell 0.1.2:**

The original curl has already failed. If you retry:

```bash
curl -v https://api.anthropic.com/v1/models
```

**Retry also fails:**

```
curl: (7) Failed to connect: Permission denied (policy rejected)
```

Policy remains rejected; no further approval will be created for this destination.

#### Demo narrative

**Key points for recording (OpenShell 0.1.2 — async flow):**

1. **Run curl:** Show terminal with curl failing immediately (Permission denied)
2. **Draft created:** Poller logs show "New pending chunk" within 5s
3. **HITLy inbox:** Show approval card with context
4. **Accept action:** Click Accept in HITLy
5. **Retry succeeds:** Re-run curl in Terminal 4 → shows API response

**Narrative for 0.1.2:**
- "OpenShell 0.1.2 is fail-fast: request denied → draft in HITLy"
- "Human accepts → policy updated"
- "Retry the request → succeeds (policy now allows)"
- "This is the working async flow on current OpenShell"

**Preferred future product story** (when OpenShell adds held-connection resume):
- "Request blocks (not denied) → HITLy Accept → same request completes (no retry)"
- When this feature ships, update docs and demo to emphasize sync resume

### Troubleshooting async demo

**"My curl fails immediately with Permission denied"**

This is **expected on OpenShell 0.1.2** (fail-fast). Working as designed.
- Verify draft chunk created: `openshell draft list --sandbox <sandbox> --status pending`
- Check HITLy inbox for approval: `http://localhost:3001/inbox`
- After Accept, **retry the request** (policy now allows)

**"curl: command not found"**

OpenShell 0.1.2 default sandbox image is **missing `/usr/bin/curl`**.

**Workaround:**
- Ops: Install curl in sandbox image before demo
- Alternative: Use `/dev/tcp` for TCP connectivity test:
  ```bash
  timeout 3 bash -c '</dev/tcp/api.anthropic.com/443' 2>&1
  # Expected: Permission denied (fail-fast)
  # After Accept: Connection refused or success
  ```
- Document curl installation as Ops prerequisite

**"Poller doesn't detect the chunk"**

- Verify `OPENSHELL_SANDBOX_IDS` includes the sandbox you're testing in
- Check poller is running: Terminal 3 should show poll logs every 5 seconds
- Manually verify chunk exists: `openshell draft list --sandbox <sandbox> --status pending`

**"HITLy shows approval but poller logs resume errors"**

- Check Terminal 3 (poller) for errors
- Look for: `ApproveDraftChunk failed: FAILED_PRECONDITION` (stale review_token)
- Check plugin credentials in HITLy project Config tab (mTLS certs, bearer token)
- This does NOT prevent policy update; on 0.1.2, **retry** the request after fixing

**"Retry still fails after Accept"**

- Verify policy approved: `openshell policy get <sandbox>` (look for approved chunk)
- Check poller logs for successful `ApproveDraftChunk` response
- Destination may need exact match (protocol, port, etc.)
- Try: `openshell draft list --sandbox <sandbox> --status approved` to see approved rules

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
- **Ops must install curl in sandbox image** before demo (see "Ops follow-up" above)

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
