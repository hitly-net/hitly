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
  if systemctl --user start hitly-db.service 2>/dev/null; then
    return 0
  fi
  nohup "${HOME}/opt/mariadb/bin/mariadbd" \
    --basedir="${HOME}/opt/mariadb" \
    --datadir="${HOME}/hitly-data/mysql" \
    --socket="${HOME}/hitly-data/mysql.sock" \
    --port=3306 \
    --bind-address=127.0.0.1 \
    --pid-file="${HOME}/hitly-data/mysqld.pid" \
    >>/tmp/hitly-db.log 2>&1 &
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

listening 3306 || start_db
listening 3000 || start_web
listening 3001 || start_app
