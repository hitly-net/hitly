#!/usr/bin/env bash
# Apply HITLy telemetry policy, then exec the command.
# Default (HITLY_TELEMETRY unset): Next.js and Turbo CLIs do not phone home.
# HITLY_TELEMETRY=1 or true (trimmed, same as apps/web/lib/telemetry.ts): leave telemetry enabled.
set -euo pipefail
flag="${HITLY_TELEMETRY:-}"
# Trim leading/trailing whitespace so '1 ' and ' true' match the JS predicates.
flag="${flag#"${flag%%[![:space:]]*}"}"
flag="${flag%"${flag##*[![:space:]]}"}"
if [[ "${flag}" == "1" || "${flag}" == "true" ]]; then
  unset NEXT_TELEMETRY_DISABLED || true
  unset TURBO_TELEMETRY_DISABLED || true
else
  export NEXT_TELEMETRY_DISABLED=1
  export TURBO_TELEMETRY_DISABLED=1
fi
exec "$@"
