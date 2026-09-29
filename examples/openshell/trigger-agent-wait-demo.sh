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
#   2. Agent POSTs proposal to /v1/proposals
#   3. Agent GETs /v1/proposals/{chunk_id}/wait → parks (long-poll)
#   4. Human Accept in HITLy → ApproveDraftChunk
#   5. /wait returns status: approved, policy_reloaded: true
#   6. Agent retries (new request) → succeeds under new rule
#
#   SYNC in this demo = agent long-poll on /v1/proposals/{chunk_id}/wait, NOT same-socket curl resume.
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

# Policy advisor API base (configurable via env, default http://policy.local)
POLICY_LOCAL_URL="${OPENSHELL_POLICY_LOCAL_URL:-http://policy.local}"

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

# Check for jq (optional, for pretty-printing)
HAS_JQ=false
if command -v jq &> /dev/null; then
  HAS_JQ=true
fi

echo "=== OpenShell HITLy Agent-Driven Demo (0.1.2) ==="
echo ""
echo "HERO PATH: Agent POSTs proposal + GETs /wait + auto-retries"
echo ""
echo "Demo URL: $URL"
echo "Policy advisor: $POLICY_LOCAL_URL"
echo "Sandbox:  ${OPENSHELL_SANDBOX_ID:-<unknown>}"
echo "Workspace: ${OPENSHELL_WORKSPACE:-<unknown>}"
echo ""
echo "Expected flow (agent-driven with /wait long-poll):"
echo "  1. curl FAILS (Permission denied, fail-fast)"
echo "  2. Agent POSTs proposal to /v1/proposals"
echo "  3. Agent GETs /v1/proposals/{chunk_id}/wait → parks (long-poll)"
echo "  4. [Agent waiting on /wait while human reviews]"
echo "  5. Human Accept in HITLy → policy updated"
echo "  6. /wait returns status: approved, policy_reloaded: true"
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

# Extract host and port from URL
if [[ "$URL" =~ ^https?://([^:/]+)(:([0-9]+))?(/.*)?$ ]]; then
  HOST="${BASH_REMATCH[1]}"
  PORT="${BASH_REMATCH[3]}"
  PATH_PART="${BASH_REMATCH[4]:-/}"
  
  # Default ports
  if [[ -z "$PORT" ]]; then
    if [[ "$URL" =~ ^https:// ]]; then
      PORT=443
    else
      PORT=80
    fi
  fi
  
  # Detect protocol
  if [[ "$URL" =~ ^https:// ]]; then
    PROTO="rest"  # HTTPS endpoints typically use rest for L7 inspection
  else
    PROTO="rest"  # HTTP also uses rest
  fi
else
  echo "❌ ERROR: Could not parse URL: $URL"
  exit 1
fi

# Step 2: POST proposal to /v1/proposals
echo "[Step 2] Agent POSTs policy proposal to $POLICY_LOCAL_URL/v1/proposals..."
echo ""
echo "   Extracted from URL:"
echo "     Host: $HOST"
echo "     Port: $PORT"
echo "     Protocol: $PROTO"
echo ""

# Build proposal JSON
# See: https://docs.nvidia.com/openshell/how-it-works/policies/advisor
RULE_NAME="agent_proposal_${HOST//./_}_${PORT}"
PROPOSAL_JSON=$(cat <<EOF
{
  "operations": [
    {
      "addRule": {
        "ruleName": "$RULE_NAME",
        "rule": {
          "name": "$RULE_NAME",
          "endpoints": [
            {
              "host": "$HOST",
              "port": $PORT,
              "protocol": "$PROTO",
              "enforcement": "enforce",
              "access": "read-only"
            }
          ],
          "binaries": [
            {
              "path": "/usr/bin/curl"
            }
          ]
        }
      }
    }
  ],
  "intent_summary": "Agent proposes access to $HOST:$PORT for curl (agent-driven demo)"
}
EOF
)

echo "   Proposal JSON:"
if [[ "$HAS_JQ" == "true" ]]; then
  echo "$PROPOSAL_JSON" | jq .
else
  echo "$PROPOSAL_JSON"
fi
echo ""

# POST the proposal
echo "   POSTing to $POLICY_LOCAL_URL/v1/proposals..."
PROPOSAL_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$PROPOSAL_JSON" \
  "$POLICY_LOCAL_URL/v1/proposals" 2>&1) || {
  echo "❌ ERROR: Failed to POST proposal"
  echo "   Response: $PROPOSAL_RESPONSE"
  echo ""
  echo "   This may indicate:"
  echo "   - policy.local /v1/proposals API not available (check agent_policy_proposals_enabled)"
  echo "   - Network policy blocking policy.local"
  echo "   - Invalid JSON payload"
  exit 1
}

echo ""
echo "   Response:"
if [[ "$HAS_JQ" == "true" ]]; then
  echo "$PROPOSAL_RESPONSE" | jq .
else
  echo "$PROPOSAL_RESPONSE"
fi
echo ""

# Extract chunk_id from response
CHUNK_ID=""
if [[ "$HAS_JQ" == "true" ]]; then
  CHUNK_ID=$(echo "$PROPOSAL_RESPONSE" | jq -r '.accepted_chunk_ids[0] // empty')
fi

# Fallback: try basic grep if jq not available or didn't find it
if [[ -z "$CHUNK_ID" ]]; then
  if [[ "$PROPOSAL_RESPONSE" =~ \"accepted_chunk_ids\"[[:space:]]*:[[:space:]]*\[\"([^\"]+)\" ]]; then
    CHUNK_ID="${BASH_REMATCH[1]}"
  fi
fi

if [[ -z "$CHUNK_ID" ]]; then
  echo "❌ ERROR: Could not extract chunk_id from proposal response"
  echo "   Response: $PROPOSAL_RESPONSE"
  echo ""
  echo "   Check for rejection_reasons in the response."
  exit 1
fi

echo "[Step 2] ✅ Proposal submitted successfully (chunk_id: $CHUNK_ID)"
echo ""

# Step 3: GET /wait (long-poll)
echo "[Step 3] Agent GETs /wait (long-poll, parks until policy reload)..."
echo ""
echo "   Endpoint: $POLICY_LOCAL_URL/v1/proposals/$CHUNK_ID/wait?timeout=300"
echo ""
echo "   Agent is now PARKED on /wait (blocking, waiting for human decision)"
echo "   Check HITLy inbox: http://localhost:3001/inbox"
echo ""

# Real long-poll GET /wait request
WAIT_START=$(date +%s)
WAIT_RESPONSE=$(curl -s -X GET \
  "$POLICY_LOCAL_URL/v1/proposals/$CHUNK_ID/wait?timeout=300" 2>&1) || {
  echo "❌ ERROR: /wait request failed"
  echo "   Response: $WAIT_RESPONSE"
  exit 1
}
WAIT_END=$(date +%s)
WAIT_DURATION=$((WAIT_END - WAIT_START))

echo ""
echo "[Step 5] /wait returned after ${WAIT_DURATION}s"
echo ""
echo "   Response:"
if [[ "$HAS_JQ" == "true" ]]; then
  echo "$WAIT_RESPONSE" | jq .
else
  echo "$WAIT_RESPONSE"
fi
echo ""

# Check if policy was reloaded
STATUS=""
if [[ "$HAS_JQ" == "true" ]]; then
  STATUS=$(echo "$WAIT_RESPONSE" | jq -r '.status // empty')
else
  if [[ "$WAIT_RESPONSE" =~ \"status\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    STATUS="${BASH_REMATCH[1]}"
  fi
fi

if [[ "$STATUS" == "approved" ]]; then
  echo "[Step 5] ✅ Proposal approved! (status: approved, policy_reloaded: true)"
  echo ""
elif [[ "$STATUS" == "rejected" ]]; then
  echo "[Step 5] ❌ Proposal rejected by human reviewer (status: rejected)"
  echo ""
  echo "   Check HITLy inbox for rejection reason."
  exit 1
elif [[ "$STATUS" == "timeout" ]] || [[ "$WAIT_RESPONSE" =~ timeout ]]; then
  echo "[Step 5] ⏱️  /wait timeout (no human decision within 300s)"
  echo ""
  echo "   Human may not have reviewed yet."
  echo "   Check HITLy inbox: http://localhost:3001/inbox"
  exit 1
else
  echo "[Step 5] ⚠️  Unexpected /wait response status: ${STATUS:-<unknown>}"
  echo "   Expected: approved | rejected | pending"
  echo ""
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
  echo "   Demo showed: deny → POST /v1/proposals → /wait parks → Accept → status:approved → retry succeeds"
  echo ""
  echo "   SYNC = agent long-poll on /v1/proposals/{chunk_id}/wait (NOT same-socket curl resume)"
  echo ""
  echo "   🎉 STICKY POLICY: Run this script again → should succeed immediately"
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
