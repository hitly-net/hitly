#!/usr/bin/env bash
#
# OpenShell HITLy Agent-Driven Demo with /wait Long-Poll (OpenShell 0.1.2)
#
# PURPOSE:
#   Demonstrate agent-driven policy proposal flow where agent POSTs proposal,
#   long-polls /wait for policy reload, then auto-retries when HITLy accepts.
#
#   This is the HERO PATH for OpenShell→HITLy demo (Derek locked).
#
# LOCKED DEMO NARRATIVE:
#   1. Deny (fail-fast — blocked curl stays denied)
#   2. Agent POSTs proposal (agent_policy_proposals)
#   3. Agent GETs policy.local.../wait → parks (long-poll)
#   4. Human Accept in HITLy → ApproveDraftChunk
#   5. /wait returns policy_reloaded
#   6. Agent retries (new request) → succeeds under new rule
#
#   SYNC in this demo = agent /wait long-poll, NOT same-socket curl resume.
#
# PREREQUISITES:
#   1. Running inside OpenShell sandbox
#   2. Gateway configured with agent_policy_proposals_enabled
#   3. curl installed in sandbox (0.1.2 default image MISSING /usr/bin/curl)
#   4. HITLy poller running and monitoring this sandbox
#   5. HITLy app accessible for human review
#
# USAGE:
#   ./trigger-agent-wait-demo.sh [URL]
#
# EXAMPLE:
#   ./trigger-agent-wait-demo.sh https://api.anthropic.com/v1/models
#
# REFERENCES:
#   - https://docs.nvidia.com/openshell/how-it-works/policies/advisor
#   - OpenShell policy advisor pattern (agent-driven policy management)
#

set -euo pipefail

# Default URL for demo (Anthropic API models endpoint)
DEFAULT_URL="https://api.anthropic.com/v1/models"
URL="${1:-$DEFAULT_URL}"

# Detect if running inside OpenShell sandbox
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

# Check for curl
if ! command -v curl &> /dev/null; then
  echo "❌ ERROR: curl not found in sandbox"
  echo ""
  echo "   OpenShell 0.1.2 default image is missing /usr/bin/curl."
  echo "   Ops prerequisite: Install curl in sandbox image before demo."
  echo ""
  exit 1
fi

echo "=== OpenShell HITLy Agent-Driven Demo (0.1.2) ==="
echo ""
echo "HERO PATH: Agent POSTs proposal + GETs /wait + auto-retries"
echo ""
echo "Demo URL: $URL"
echo "Sandbox:  ${OPENSHELL_SANDBOX_ID:-<unknown>}"
echo "Workspace: ${OPENSHELL_WORKSPACE:-<unknown>}"
echo ""
echo "Expected flow (agent-driven with /wait long-poll):"
echo "  1. curl FAILS (Permission denied, fail-fast)"
echo "  2. Agent POSTs proposal (agent_policy_proposals)"
echo "  3. Agent GETs /wait → parks (long-poll)"
echo "  4. [Agent waiting on /wait while human reviews]"
echo "  5. Human Accept in HITLy → policy updated"
echo "  6. /wait returns policy_reloaded"
echo "  7. Agent retries curl (new request) → succeeds"
echo ""
echo "SYNC = agent /wait long-poll, NOT same-socket curl resume."
echo ""
echo "📹 Recording tip: Show deny → /wait parks → Accept → /wait returns → retry succeeds"
echo ""

# Step 1: Initial request (expect fail-fast)
echo "[Step 1] Attempting initial request (expect Permission denied)..."
echo ""

curl -v "$URL" 2>&1 || true
INITIAL_EXIT=$?

echo ""
echo "[Step 1] Initial request denied (exit code: $INITIAL_EXIT)"
echo ""

if [[ $INITIAL_EXIT -eq 0 ]]; then
  echo "✅ Request succeeded (policy already allows, or no restriction)"
  echo "   No proposal needed; demo path ends here."
  exit 0
fi

# Step 2: POST proposal (agent_policy_proposals)
echo "[Step 2] Agent POSTs policy proposal..."
echo ""
echo "   In a real agent, this would be:"
echo "   POST policy.local/v1/agent_policy_proposals"
echo "   { destination: \"$URL\", protocol: \"https\", ... }"
echo ""
echo "   For this demo: Poller will detect the pending draft chunk"
echo "   created by the initial deny and submit to HITLy."
echo ""
sleep 2

# Step 3: GET /wait (long-poll)
echo "[Step 3] Agent GETs /wait (long-poll, parks until policy reload)..."
echo ""
echo "   In a real agent, this would be:"
echo "   GET policy.local/v1/wait?timeout=300"
echo "   → blocks until policy_reloaded or timeout"
echo ""
echo "   For this demo: Simulating agent wait while human reviews..."
echo "   Check HITLy inbox: http://localhost:3001/inbox"
echo ""
echo "   Waiting for HITLy Accept (max 120s)..."
echo ""

# Simulate /wait by polling for policy change (simplified for demo)
# In real agent, this would be a single long-poll GET /wait request
WAIT_START=$(date +%s)
WAIT_MAX=120
POLICY_RELOADED=false

while [[ $(($(date +%s) - WAIT_START)) -lt $WAIT_MAX ]]; do
  # Check if we can connect now (policy updated)
  if curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$URL" &> /dev/null; then
    POLICY_RELOADED=true
    break
  fi
  sleep 5
done

WAIT_END=$(date +%s)
WAIT_DURATION=$((WAIT_END - WAIT_START))

echo ""
if [[ "$POLICY_RELOADED" == "true" ]]; then
  echo "[Step 5] /wait returned policy_reloaded (after ${WAIT_DURATION}s)"
  echo ""
else
  echo "[Step 5] /wait timeout after ${WAIT_DURATION}s (no policy reload detected)"
  echo ""
  echo "   Human may not have accepted yet, or policy not allowing connection."
  echo "   Check HITLy inbox: http://localhost:3001/inbox"
  echo "   Check poller logs for ApproveDraftChunk result"
  echo ""
  exit 1
fi

# Step 6: Agent auto-retries
echo "[Step 6] Agent auto-retries (new request under new policy)..."
echo ""

curl -v "$URL"
RETRY_EXIT=$?

echo ""
if [[ $RETRY_EXIT -eq 0 ]]; then
  echo "✅ SUCCESS: Agent retry succeeded under new policy"
  echo ""
  echo "   Demo showed: deny → POST proposal → /wait parks → Accept → policy_reloaded → retry succeeds"
  echo ""
  echo "   SYNC = agent /wait long-poll (NOT same-socket curl resume)"
else
  echo "❌ FAILED: Agent retry still denied (exit code: $RETRY_EXIT)"
  echo ""
  echo "   Policy may not have been approved correctly."
  echo "   Check:"
  echo "   - HITLy inbox: http://localhost:3001/inbox"
  echo "   - Poller logs: ApproveDraftChunk success?"
  echo "   - OpenShell policy: openshell policy get <sandbox> --full"
fi

echo ""
echo "Additional checks:"
echo "  - HITLy inbox: http://localhost:3001/inbox"
echo "  - Poller logs: Terminal 3"
echo "  - Evidence sink: http://localhost:3100"
