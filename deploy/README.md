# HITLy production deploy (LAN)

User-level systemd units for **production** Next.js on the Ubuntu host `<your-host>` (repo at `~/hitly`).

Local Mac development still uses `yarn dev:web` / `yarn dev:app` and `yarn db:up`. Agent procedure: [`.cursor/skills/hitly-deployment/SKILL.md`](../.cursor/skills/hitly-deployment/SKILL.md).

| Item | Value |
|------|--------|
| Host | `<your-host>` |
| SSH | `<user>@<your-host>` |
| App path | `/home/derek/hitly` |
| Git remote | `https://github.com/hitly-net/hitly.git` (`main`) |
| Web | `http://<your-host>:3000` |
| App | `http://<your-host>:3001` |
| DB | Docker Compose Postgres 16 (`docker-compose.yml`, port 5432) |

Existing LAN hosts that still have MariaDB on 3306 need a new Postgres volume and `yarn db:migrate`. There is no automated MariaDB data migration.

No nginx/TLS. Ports bind `0.0.0.0`. Mobile and the Mastra example stay off this host.

## Services

| Unit | Command | Role |
|------|---------|------|
| `hitly-web.service` | `yarn workspace @hitly/web start --hostname 0.0.0.0` | Marketing + docs on `:3000` |
| `hitly-app.service` | `yarn workspace @hitly/app start --hostname 0.0.0.0` | Product inbox on `:3001` |

Postgres remains under Docker Compose (`docker compose up -d` in the repo root).

## One-time bootstrap

On the host, with SSH key auth already working:

1. Install `git`, `curl`, Docker Engine + Compose plugin; add `derek` to the `docker` group.
2. Install nvm + Node 22; enable Yarn 1.22.22 (`corepack enable && corepack prepare yarn@1.22.22 --activate`).
3. `sudo loginctl enable-linger derek`
4. If `ufw` is active: `sudo ufw allow 3000/tcp && sudo ufw allow 3001/tcp`
5. `git clone https://github.com/hitly-net/hitly.git ~/hitly`
6. Create server-only env (gitignored). Do not copy laptop `.env` files.

`apps/web/.env.production`:

```
NEXT_PUBLIC_APP_URL=http://<your-host>:3001
```

`apps/app/.env.production`:

```
WEB_URL=http://<your-host>:3000
BETTER_AUTH_URL=http://<your-host>:3001
BETTER_AUTH_SECRET=<openssl rand -hex 32>
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/hitly
NEXT_PUBLIC_WEB_URL=http://<your-host>:3000
HITLY_TRUSTED_PROXY_COUNT=0
```

If evidence sinks, OTEL collectors or agents run on this host or the private network, also set `HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS=true` in `apps/app/.env.production`. Without it, production refuses private and loopback destinations (see the self-host guide, "Outbound destinations").

Production refuses to start (the process exits with a message naming the variable) when `BETTER_AUTH_SECRET` is missing, shorter than 32 characters or a placeholder, or when `DATABASE_URL` uses a development or placeholder password such as the `hitly` password from the local `docker-compose.yml`. Give the production database its own password.

**Client addresses.** Per-client limits (Better Auth's request limiter and the reset page's link check) need to know which `X-Forwarded-For` entry is the client. Set one of these in `apps/app/.env.production`:

- `HITLY_TRUSTED_PROXIES`: comma-separated IP addresses or CIDR ranges of the reverse proxies in front of the app. The client is the right-most entry that is not one of them. A malformed entry stops the server at start.
- `HITLY_TRUSTED_PROXY_COUNT`: used when the list is unset. The number of proxies in front of the app that append to `X-Forwarded-For` (default `1`, at most `5`).
- **No reverse proxy** (the setup on this page, with the app port open directly): set `HITLY_TRUSTED_PROXY_COUNT=0`. Clients could otherwise choose the address they are counted under. With `0` there is no per-client address, so the reset page's link check uses one shared ceiling instead of a per-client limit. The server logs a warning about this at start. Putting a reverse proxy in front and setting the count or list restores per-client limits.

At start the server logs the effective setting: the proxy count, or how many trusted proxy entries are configured (never the addresses).

Generate the secret with `openssl rand -hex 32`. `NEXT_PUBLIC_*` is inlined at `yarn build`; changing those URLs later requires a rebuild.

7. `cd ~/hitly && docker compose up -d --wait`

## Install / refresh units

After `git pull` on the host:

```bash
cd ~/hitly
bash scripts/systemd/install-user-units.sh
```

This copies units from `deploy/systemd/user/` into `~/.config/systemd/user/`, reloads the user systemd manager, and `enable --now` both units.

Units should keep running after SSH logout (`loginctl show-user "$USER" -p Linger` → `yes`). If not: `sudo loginctl enable-linger "$USER"`. Until linger is enabled, `scripts/systemd/ensure-up.sh` can be installed as a user cron (`* * * * *`).

## Recurring deploy

From the laptop, after commit + `git push origin main`:

```bash
ssh <user>@<your-host> 'bash -lc "
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

Rules:

- `--ff-only` so a dirty or diverged server tree fails loudly.
- Never overwrite remote `.env.production` from the laptop. Merge new keys from `.env.example` by hand.
- Run `yarn db:migrate` every deploy (safe no-op).
- Refresh units after every pull.

## Operations

```bash
systemctl --user status hitly-web hitly-app
systemctl --user restart hitly-web hitly-app
journalctl --user -u hitly-web -f
journalctl --user -u hitly-app -f
```

Env vars come from `apps/web/.env.production` and `apps/app/.env.production` (loaded by Next at build/start). `yarn db:migrate` needs `DATABASE_URL` sourced from `apps/app/.env.production`.
