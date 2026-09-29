#!/usr/bin/env bash
#
# OpenShell HITLy Synchronous Demo Trigger
#
# PURPOSE:
#   Run this script INSIDE an OpenShell sandbox to trigger a
#   human-review flow. The network request INTENDS to block at the
#   OpenShell policy wall and resume when HITLy approves/rejects.
#
# ⚠️  KNOWN LIMITATION (OpenShell 0.1.2):
#   Held-connection resume behavior is UNVERIFIED on OpenShell 0.1.2.
#   ApproveDraftChunk/RejectDraftChunk may only update policy and NOT
#   resume the blocked request. If curl stays blocked after HITLy decision,
#   you may need to RETRY the request manually after Accept.
#
#   Ops must verify actual behavior on your OpenShell version before
#   using this for demo recordings.
#
# USAGE:
#   ./trigger-sync-demo.sh [URL]
#
# EXAMPLE:
#   ./trigger-sync-demo.sh https://api.anthropic.com/v1/models
#
# PREREQUISITES:
#   1. Running inside an OpenShell sandbox
#   2. Sandbox configured for blocking human-review mode
#      (proposal_approval_mode=blocking or similar)
#   3. HITLy poller running and monitoring this sandbox
#   4. HITLy app accessible for human review
#
# INTENDED FLOW (when gateway supports held-connection resume):
#   1. curl command blocks (connection held by OpenShell)
#   2. Poller detects draft chunk within 5 seconds
#   3. HITLy approval appears in inbox
#   4. Human accepts/rejects in HITLy
#   5. THIS SCRIPT's curl completes (same request, no retry)
#
# FALLBACK (OpenShell 0.1.2 observed behavior):
#   1-4. Same as above
#   5. curl may stay blocked or time out
#   6. Operator must RETRY the request manually (policy is approved)
#
# DEMO RECORDING TIPS:
#   - Test on your OpenShell version BEFORE recording
#   - If held-connection resume works: emphasize "same request, no retry"
#   - If retry needed: document as "approve-then-retry on OpenShell [version]"
#   - Run this in a visible terminal (Terminal 4)
#   - Show the terminal BEFORE accepting in HITLy (curl is waiting)
#   - Accept in HITLy inbox (Terminal/Browser)
#   - Return to Terminal 4 to show result (completion or need for retry)
#

set -euo pipefail

# Default URL for demo (Anthropic API models endpoint)
DEFAULT_URL="https://api.anthropic.com/v1/models"
URL="${1:-$DEFAULT_URL}"

# Detect if running inside OpenShell sandbox
# (OpenShell sets OPENSHELL_SANDBOX_ID or similar env var)
if [[ -z "${OPENSHELL_SANDBOX_ID:-}" && -z "${OPENSHELL_WORKSPACE:-}" ]]; then
  echo "⚠️  WARNING: Not detected as running inside OpenShell sandbox"
  echo "   This script should run INSIDE the sandbox for blocking demo"
  echo "   OPENSHELL_SANDBOX_ID or OPENSHELL_WORKSPACE not set"
  echo ""
  read -p "Continue anyway? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

echo "=== OpenShell HITLy Synchronous Demo ==="
echo ""
echo "⚠️  KNOWN LIMITATION (OpenShell 0.1.2):"
echo "   Held-connection resume is UNVERIFIED on OpenShell 0.1.2."
echo "   If curl stays blocked after HITLy Accept, you may need to"
echo "   RETRY the request manually (policy will be approved)."
echo ""
echo "Demo URL: $URL"
echo "Sandbox:  ${OPENSHELL_SANDBOX_ID:-<unknown>}"
echo "Workspace: ${OPENSHELL_WORKSPACE:-<unknown>}"
echo ""
echo "Intended flow (when gateway supports held-connection resume):"
echo "  1. This curl will BLOCK (not fail immediately)"
echo "  2. OpenShell creates draft chunk (human_review_required)"
echo "  3. Poller detects chunk and creates HITLy approval (within 5s)"
echo "  4. Human reviews in HITLy inbox: http://localhost:3001/inbox"
echo "  5. Accept → this curl completes with response"
echo "     Reject → this curl fails with policy error"
echo ""
echo "Fallback (if held-connection resume not available):"
echo "  1-4. Same as above"
echo "  5. curl may stay blocked or time out"
echo "  6. Retry request manually → succeeds (policy approved)"
echo ""
echo "📹 Recording tip: Test on your OpenShell version first"
echo ""
echo "Starting request..."
echo ""

# Timestamp for correlation
START_TIME=$(date +%s)
echo "[$(date -Iseconds)] Request started (blocking mode)"
echo ""

# Run curl with verbose output to show blocking behavior
# The -v flag helps demonstrate that curl is waiting, not failed
curl -v "$URL"
EXIT_CODE=$?

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "[$(date -Iseconds)] Request completed (exit code: $EXIT_CODE)"
echo "Duration: ${DURATION}s"
echo ""

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "✅ SUCCESS: Request completed"
  echo ""
  echo "   Possible causes:"
  echo "   - Held-connection resume worked (gateway released connection)"
  echo "   - Request was approved and retried manually"
  echo "   - Policy was already approved from earlier run"
  echo ""
  echo "   If duration > 5s, likely waited for human decision."
  echo "   Verify in HITLy inbox and poller logs."
else
  echo "❌ FAILED: Request rejected or errored (exit code: $EXIT_CODE)"
  echo ""
  echo "   Possible causes:"
  echo "   - Human rejected in HITLy (expected for reject demo)"
  echo "   - Sandbox not in blocking mode (fails immediately)"
  echo "   - Held-connection resume not available (stayed blocked/timed out)"
  echo "   - Network unreachable for other reasons"
  echo ""
  echo "   If curl timed out or stayed blocked after HITLy Accept:"
  echo "   - Policy may be approved (check: openshell policy get <sandbox>)"
  echo "   - Retry the request manually: curl $URL"
  echo "   - If retry succeeds: held-connection resume not available on this version"
fi

echo ""
echo "Next steps:"
echo "  - Check HITLy inbox for approval status"
echo "  - Check poller logs (Terminal 3) for draft detection + resume outcome"
echo "  - Check evidence sink (http://localhost:3100) for event chain"
echo "  - If curl stayed blocked: verify OpenShell version supports held-connection resume"
