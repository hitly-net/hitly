#!/usr/bin/env bash
#
# OpenShell HITLy Synchronous Demo Trigger
#
# PURPOSE:
#   Run this script INSIDE an OpenShell sandbox to trigger a synchronous
#   human-review flow. The network request will BLOCK at the OpenShell
#   policy wall, wait for HITLy approval, then complete with the same
#   in-flight request.
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
# EXPECTED FLOW:
#   1. curl command blocks (connection held by OpenShell)
#   2. Poller detects draft chunk within 5 seconds
#   3. HITLy approval appears in inbox
#   4. Human accepts/rejects in HITLy
#   5. THIS SCRIPT's curl completes (same request, no retry)
#
# DEMO RECORDING TIPS:
#   - Run this in a visible terminal (Terminal 4)
#   - Show the terminal BEFORE accepting in HITLy (curl is waiting)
#   - Accept in HITLy inbox (Terminal/Browser)
#   - Return to Terminal 4 to show curl output appearing
#   - Emphasize: "same request, no retry needed"
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
echo "Demo URL: $URL"
echo "Sandbox:  ${OPENSHELL_SANDBOX_ID:-<unknown>}"
echo "Workspace: ${OPENSHELL_WORKSPACE:-<unknown>}"
echo ""
echo "Expected flow:"
echo "  1. This curl will BLOCK (not fail immediately)"
echo "  2. OpenShell creates draft chunk (human_review_required)"
echo "  3. Poller detects chunk and creates HITLy approval (within 5s)"
echo "  4. Human reviews in HITLy inbox: http://localhost:3001/inbox"
echo "  5. Accept → this curl completes with response"
echo "     Reject → this curl fails with policy error"
echo ""
echo "📹 Recording tip: Keep this terminal visible while reviewing in HITLy"
echo ""
echo "Starting synchronous request..."
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
  echo "✅ SUCCESS: Request completed after human approval"
  echo "   Demo showed: blocked → HITLy inbox → accept → same request completed"
else
  echo "❌ FAILED: Request rejected or errored (exit code: $EXIT_CODE)"
  echo "   Possible causes:"
  echo "   - Human rejected in HITLy (expected for reject demo)"
  echo "   - Sandbox not in blocking mode (fails immediately instead of waiting)"
  echo "   - Network unreachable for other reasons"
fi

echo ""
echo "Next steps:"
echo "  - Check HITLy inbox for approval status"
echo "  - Check poller logs (Terminal 3) for draft detection"
echo "  - Check evidence sink (http://localhost:3100) for event chain"
