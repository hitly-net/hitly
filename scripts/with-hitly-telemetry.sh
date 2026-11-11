#!/usr/bin/env bash
# Apply HITLy telemetry policy, then exec the command.
# Default (HITLY_TELEMETRY unset): Next.js CLI does not phone home.
# HITLY_TELEMETRY=1 or true: leave Next telemetry enabled.
set -euo pipefail
flag="${HITLY_TELEMETRY:-}"
if [[ "${flag}" == "1" || "${flag}" == "true" ]]; then
  unset NEXT_TELEMETRY_DISABLED || true
else
  export NEXT_TELEMETRY_DISABLED=1
fi
exec "$@"
