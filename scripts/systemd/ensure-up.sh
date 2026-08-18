#!/usr/bin/env bash
# Keep Hitly production processes up when user linger is not enabled.
# Intended for 192.168.10.176 until `loginctl enable-linger derek` can run as root.
set -euo pipefail

export PATH="${HOME}/.local/bin:${HOME}/.local/envs/dev/bin:${PATH}"
# shellcheck disable=SC1091
[ -s "${HOME}/.nvm/nvm.sh" ] && . "${HOME}/.nvm/nvm.sh"

listening() {
  ss -lptn 2>/dev/null | grep -q ":${1} "
}

start_db() {
  cd "${HOME}/hitly"
  docker compose up -d --wait
}

start_web() {
  if systemctl --user start hitly-web.service 2>/dev/null; then
    return 0
  fi
  cd "${HOME}/hitly"
  nohup yarn workspace @hitly/web start --hostname 0.0.0.0 >>/tmp/hitly-web.log 2>&1 &
}

start_app() {
  if systemctl --user start hitly-app.service 2>/dev/null; then
    return 0
  fi
  cd "${HOME}/hitly"
  nohup yarn workspace @hitly/app start --hostname 0.0.0.0 >>/tmp/hitly-app.log 2>&1 &
}

listening 5432 || start_db
listening 3000 || start_web
listening 3001 || start_app
