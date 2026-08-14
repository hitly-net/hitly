---
name: hitly-deployment
description: >-
  Deploy Hitly to the LAN production host (192.168.10.176): commit/push to
  github.com/hitly-net/hitly, pull + install + migrate + build on the host,
  refresh user systemd units, restart hitly-web (port 3000) and hitly-app
  (port 3001). Use when the user asks to deploy Hitly, update the LAN server,
  restart hitly-web/hitly-app, or follow the production deploy guide.
---

# Hitly deployment (LAN production)

Project skill for shipping this monorepo to the Ubuntu host. Operator notes: [deploy/README.md](../../../deploy/README.md).

## Target

| Item | Value |
|------|--------|
| Host | `192.168.10.176` |
| SSH | `derek@192.168.10.176` (key auth) |
| App path | `/home/derek/hitly` |
| Git remote | `https://github.com/hitly-net/hitly.git` (`main`) |
| Web | `http://192.168.10.176:3000` (`yarn workspace @hitly/web start`) |
| App | `http://192.168.10.176:3001` (`yarn workspace @hitly/app start`) |
| Infra | Docker Compose MariaDB in `~/hitly` |

## Runtime model

The host runs **production** Next.js (`yarn turbo build --filter=@hitly/web --filter=@hitly/app` then `next start`) under **user systemd**. Unit sources live in the repo:

| Unit | Repo source | Installed path | Command |
|------|-------------|----------------|---------|
| `hitly-web.service` | `deploy/systemd/user/hitly-web.service` | `~/.config/systemd/user/` | `@hitly/web start` on `:3000` |
| `hitly-app.service` | `deploy/systemd/user/hitly-app.service` | `~/.config/systemd/user/` | `@hitly/app start` on `:3001` |

Install/refresh on the host: `bash scripts/systemd/install-user-units.sh`. Both units `source ~/.nvm/nvm.sh` then run Yarn from `%h/hitly`.

Docker (MariaDB) is expected to already be up:

```bash
ssh derek@192.168.10.176 'cd ~/hitly && docker compose ps'
```

Mobile and the Mastra example stay off this host.

## Standard deploy procedure

Run from the **local** Hitly clone. Prefer completing git locally, then deploying over SSH.

### 1. Commit and push (local)

1. Review `git status` / `git diff`. Exclude secrets (`.env`, `.env.local`, `.env.production`, credentials).
2. Commit on `main`.
3. `git push origin main` to [hitly-net/hitly](https://github.com/hitly-net/hitly).

The server deploys by **pulling from GitHub**, not by rsync from the laptop.

### 2. Pull, install, migrate, build, refresh units, restart (remote)

```bash
ssh derek@192.168.10.176 'bash -lc "
set -euo pipefail
source \$HOME/.nvm/nvm.sh
cd \$HOME/hitly

git fetch origin
git pull --ff-only origin main

yarn install --frozen-lockfile
docker compose up -d --wait

set -a && source apps/app/.env.production && set +a
yarn db:migrate
yarn turbo build --filter=@hitly/web --filter=@hitly/app

bash scripts/systemd/install-user-units.sh
systemctl --user restart hitly-web.service hitly-app.service
sleep 4
systemctl --user --no-pager status hitly-web.service hitly-app.service
curl -sf -o /dev/null -w \"web HTTP %{http_code}\\n\" http://127.0.0.1:3000/
curl -sf -o /dev/null -w \"app HTTP %{http_code}\\n\" http://127.0.0.1:3001/
git log -1 --oneline
"'
```

Notes:

- Always load nvm in non-interactive SSH (`source ~/.nvm/nvm.sh`); bare `node`/`yarn` are not on the default PATH.
- Prefer `--ff-only` so a dirty or diverged server tree fails loudly.
- Run `yarn db:migrate` even when you expect no new migrations (safe no-op).
- Run `bash scripts/systemd/install-user-units.sh` after every pull so unit file changes are applied (safe when unchanged).
- Do **not** overwrite remote `.env.production` from the laptop. Merge new keys from `.env.example` manually when needed.
- `NEXT_PUBLIC_*` is inlined at build. Changing public URLs requires a rebuild.
- Build only `@hitly/web` and `@hitly/app`. Do not `yarn build` the whole workspace (Mastra example / mobile are not deployed here).

### 3. Verify

- Units: `active (running)` for both services.
- Web: HTTP 200 from `http://127.0.0.1:3000/` on the host (or `http://192.168.10.176:3000` from LAN).
- App: reachable at `http://192.168.10.176:3001/` (login). Docs “Open app” should point at `:3001`.

```bash
ssh derek@192.168.10.176 'journalctl --user -u hitly-web.service -n 40 --no-pager'
ssh derek@192.168.10.176 'journalctl --user -u hitly-app.service -n 40 --no-pager'
```

## One-time bootstrap

On a fresh Ubuntu host (SSH key auth already in place):

1. Install `git`, `curl`, Docker Engine + Compose plugin; add `derek` to `docker`.
2. Install nvm + **Node 22**; enable Yarn 1.22.22 via Corepack.
3. `sudo loginctl enable-linger derek` so user units survive SSH logout.
4. If `ufw` is active: allow `3000/tcp` and `3001/tcp`.
5. `git clone https://github.com/hitly-net/hitly.git ~/hitly`
6. Write server-only env (never commit):

`apps/web/.env.production`:

```
NEXT_PUBLIC_APP_URL=http://192.168.10.176:3001
```

`apps/app/.env.production`:

```
WEB_URL=http://192.168.10.176:3000
BETTER_AUTH_URL=http://192.168.10.176:3001
BETTER_AUTH_SECRET=<openssl rand -hex 32>
DATABASE_URL=mysql://hitly:hitly@127.0.0.1:3306/hitly
NEXT_PUBLIC_WEB_URL=http://192.168.10.176:3000
```

7. `cd ~/hitly && docker compose up -d --wait`

If the GitHub repo is private, clone over SSH with a read-only deploy key.

## Common operations

### Restart only

```bash
ssh derek@192.168.10.176 'systemctl --user restart hitly-web.service hitly-app.service'
```

### Restart infra (MariaDB)

```bash
ssh derek@192.168.10.176 'cd ~/hitly && docker compose up -d'
```

Preserve named volumes; do not `docker compose down -v` unless wiping data is intentional.

### Env updates on the server

1. SSH in, edit `~/hitly/apps/app/.env.production` and/or `apps/web/.env.production`.
2. Diff against local/repo `.env.example` for new variables.
3. Rebuild if `NEXT_PUBLIC_*` changed, then restart both user services.

### Dirty working tree on the server

If `git pull --ff-only` fails:

```bash
ssh derek@192.168.10.176 'cd ~/hitly && git status && git diff'
```

Discard only deliberate local hacks, or stash, then pull. Do not force-push `main` to “fix” the server.

## Checklist (agent)

When the user asks to deploy Hitly to the LAN server:

1. Summarize pending local changes; commit if asked (or if they already asked to package/commit). Exclude secrets.
2. Push to `origin/main` (`https://github.com/hitly-net/hitly.git`).
3. SSH deploy script above (pull → install → migrate → build → `install-user-units.sh`).
4. Confirm HTTP responses and both systemd units active; report the deployed commit SHA.
5. Mention any new `.env.example` keys that may need adding on the server.

## Out of scope

- TLS, public DNS, reverse proxy.
- Cloud `@hitly/cloud` overlay, Expo mobile, Mastra example on this host.
- Overwriting remote env from the laptop.
- Deploying to hosts other than `192.168.10.176` without updating this skill.
