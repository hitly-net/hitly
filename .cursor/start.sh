#!/usr/bin/env bash
# Cloud Agent start step for Hitly.
# Runs on every boot: brings up the MariaDB service and applies migrations.
# Must tolerate restarts and reach a clear success/failure state.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# The platform provides the Docker daemon over TCP; point the client at it.
export DOCKER_HOST="${DOCKER_HOST:-tcp://127.0.0.1:2375}"

# Wait for the Docker daemon to accept connections.
for _ in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# Bring up MariaDB. Compose `--wait` blocks until the healthcheck passes.
yarn db:up

# Apply Drizzle migrations (idempotent: already-applied migrations are skipped).
yarn db:migrate
