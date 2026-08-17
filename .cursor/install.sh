#!/usr/bin/env bash
# Cloud Agent install step for Hitly.
# Idempotent, non-interactive repository bootstrap. Runs after the source is
# checked out and (with environment builds) is baked into the base snapshot.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# 1. Docker CLI + compose plugin.
# The Docker daemon itself is provided by the platform (reachable over
# tcp://127.0.0.1:2375); we only need the client to talk to it so that
# `yarn db:up` can bring up the MariaDB service defined in docker-compose.yml.
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  sudo install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce-cli docker-compose-plugin
fi

# 2. Workspace dependencies (Yarn 1 + Turbo monorepo).
yarn install --frozen-lockfile

# 3. App environment file. The real app reads apps/app/.env.local; seed it from
# the checked-in example and generate a development auth secret if absent.
if [ ! -f apps/app/.env.local ]; then
  cp apps/app/.env.example apps/app/.env.local
  secret="$(openssl rand -hex 16)"
  sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=${secret}|" apps/app/.env.local
fi
