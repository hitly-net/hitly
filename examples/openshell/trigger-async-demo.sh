#!/usr/bin/env bash
#
# OpenShell HITLy Async Demo Trigger (OpenShell 0.1.2)
#
# PURPOSE:
#   Run this script INSIDE an OpenShell sandbox to trigger an
#   async human-review flow. The network request will FAIL immediately
#   (fail-fast) and create a draft chunk in HITLy. After Accept,
#   RE-RUN this script and the request will succeed.
#
# ⚠️  OpenShell 0.1.2 is FAIL-FAST (Ops verified):
#   - Denied TCP connections fail immediately (~0s Permission denied)
#   - ApproveDraftChunk/RejectDraftChunk update policy but do NOT resume
#   - No "blocking" approval mode exists (only manual|auto)
#   - After Accept, RETRY the request manually (policy now allows)
#
#   Preferred long-term product story (requires OpenShell held-connection
#   feature): In-flight request blocks → HITLy Accept → same request
#   completes. NOT available on 0.1.2; demo shows async flow.
#
# USAGE:
#   ./trigger-async-demo.sh [URL]
#
# EXAMPLE (first run - expect fail):
#   ./trigger-async-demo.sh https://api.anthropic.com/v1/models
#   # → Permission denied + draft created
#
# EXAMPLE (after HITLy Accept - expect success):
#   ./trigger-async-demo.sh https://api.anthropic.com/v1/models
#   # → Success (policy now allows)
#
# PREREQUISITES:
#   1. Running inside an OpenShell sandbox
#   2. Sandbox configured for proposal_approval_mode=manual
#   3. curl installed in sandbox (0.1.2 default image MISSING /usr/bin/curl)
#      - Ops: Install curl in sandbox image before demo
#      - Alternative: Use /dev/tcp (see script fallback)
#   4. HITLy poller running and monitoring this sandbox
#   5. HITLy app accessible for human review
#
# EXPECTED FLOW (OpenShell 0.1.2 fail-fast):
#   1. curl command FAILS immediately (Permission denied ~0s)
#   2. Draft chunk created (human_review_required)
#   3. Poller detects draft within 5 seconds → HITLy approval
#   4. Human accepts in HITLy → policy updated
#   5. VERIFY policy: openshell policy get <sandbox> --full
#   6. RE-RUN this script (new curl, not same process) → succeeds
#
# DEMO RECORDING TIPS:
#   - Show fail-fast: curl exits immediately with error
#   - Check poller logs: draft detected within 5s
#   - Accept in HITLy inbox
#   - Re-run script in same terminal → succeeds
#   - Narrative: "Denied → draft in HITLy → Accept → retry succeeds"
#

set -euo pipefail

# Default URL for demo (Anthropic API models endpoint)
DEFAULT_URL="https://api.anthropic.com/v1/models"
URL="${1:-$DEFAULT_URL}"

# Detect if running inside OpenShell sandbox
# (OpenShell sets OPENSHELL_SANDBOX_ID or similar env var)
if [[ -z "${OPENSHELL_SANDBOX_ID:-}" && -z "${OPENSHELL_WORKSPACE:-}" ]]; then
  echo "⚠️  WARNING: Not detected as running inside OpenShell sandbox"
  echo "   This script should run INSIDE the sandbox"
  echo "   OPENSHELL_SANDBOX_ID or OPENSHELL_WORKSPACE not set"
  echo ""
  read -p "Continue anyway? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Check for curl (0.1.2 default image missing /usr/bin/curl)
if ! command -v curl &> /dev/null; then
  echo "❌ ERROR: curl not found in sandbox"
  echo ""
  echo "   OpenShell 0.1.2 default image is missing /usr/bin/curl."
  echo "   Ops prerequisite: Install curl in sandbox image before demo."
  echo ""
  echo "   Alternative (TCP connectivity test with /dev/tcp):"
  echo "     timeout 3 bash -c '</dev/tcp/api.anthropic.com/443' 2>&1"
  echo "     # Expected first run: Permission denied (fail-fast)"
  echo "     # After HITLy Accept: Connection refused or timeout (policy allows)"
  echo ""
  exit 1
fi

echo "=== OpenShell HITLy Async Demo (0.1.2) ==="
echo ""
echo "⚠️  OpenShell 0.1.2 is FAIL-FAST (Ops verified):"
echo "   - Request will be DENIED immediately (Permission denied ~0s)"
echo "   - Draft chunk created for HITLy review"
echo "   - After Accept, RE-RUN this script (retry)"
echo ""
echo "Demo URL: $URL"
echo "Sandbox:  ${OPENSHELL_SANDBOX_ID:-<unknown>}"
echo "Workspace: ${OPENSHELL_WORKSPACE:-<unknown>}"
echo ""
echo "Expected flow (OpenShell 0.1.2 fail-fast):"
echo "  1. This curl will FAIL immediately (Permission denied)"
echo "  2. OpenShell creates draft chunk (human_review_required)"
echo "  3. Poller detects chunk and creates HITLy approval (within 5s)"
echo "  4. Human reviews in HITLy inbox: http://localhost:3001/inbox"
echo "  5. Accept → policy updated"
echo "  6. VERIFY policy: openshell policy get <sandbox> --full"
echo "  7. RE-RUN this script (new curl, not same process) → succeeds"
echo ""
echo "📹 Recording tip: Show fail → Accept in HITLy → re-run → success"
echo ""
echo "Starting request (expect fail-fast on first run)..."
echo ""

# Timestamp for correlation
START_TIME=$(date +%s)
echo "[$(date -Iseconds)] Request started"
echo ""

# Run curl
curl -v "$URL"
EXIT_CODE=$?

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "[$(date -Iseconds)] Request completed (exit code: $EXIT_CODE)"
echo "Duration: ${DURATION}s"
echo ""

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "✅ SUCCESS: Request allowed by policy"
  echo ""
  echo "   Policy was approved (either earlier or just now)."
  echo "   On OpenShell 0.1.2, this is the SECOND run after HITLy Accept."
  echo ""
  echo "   Demo showed: fail-fast → draft → HITLy Accept → retry → success"
else
  echo "❌ FAILED: Request denied (exit code: $EXIT_CODE)"
  echo ""
  echo "   On OpenShell 0.1.2, this is EXPECTED on first run (fail-fast)."
  echo ""
  echo "   Next steps:"
  echo "   1. Verify draft created: openshell draft list --sandbox <sandbox> --status pending"
  echo "   2. Check HITLy inbox: http://localhost:3001/inbox"
  echo "   3. Check poller logs (Terminal 3) for draft detection"
  echo "   4. Accept in HITLy inbox → policy approved"
  echo "   5. VERIFY policy updated: openshell policy get <sandbox> --full"
  echo "   6. RE-RUN this script (new curl): $0 $URL"
  echo "   7. Second run should succeed (policy now allows; not same process)"
  echo ""
  echo "   If this is a SECOND run and still fails:"
  echo "   - Verify policy approved: openshell policy get <sandbox>"
  echo "   - Check poller logs for ApproveDraftChunk success"
  echo "   - Destination/port may not match approved rule exactly"
fi

echo ""
echo "Additional checks:"
echo "  - HITLy inbox: http://localhost:3001/inbox"
echo "  - Poller logs: Terminal 3 (draft detection + resume outcome)"
echo "  - Evidence sink: http://localhost:3100 (event chain)"
