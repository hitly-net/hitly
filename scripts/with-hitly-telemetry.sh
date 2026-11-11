#!/usr/bin/env bash
# Always disable Next.js and Turbo CLI telemetry. HITLY_TELEMETRY only gates
# the marketing-site Plausible snippet (apps/web), not these CLIs.
set -euo pipefail
export NEXT_TELEMETRY_DISABLED=1
export TURBO_TELEMETRY_DISABLED=1
exec "$@"
