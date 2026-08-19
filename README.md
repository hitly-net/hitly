# Hitly

Apache-2.0 human-in-the-loop inbox for Mastra, Hermes, HTTP, n8n. LangGraph and Temporal coming soon.

Self-host this repo. Cloud-only features (Stripe billing, usage metering, SSO) live in a private overlay package — they are not env-var flags in this tree. `cloud.hitly.net` is reserved for a hosted offering (waitlist-only); join the waitlist at [hitly.net](https://hitly.net).

- `hitly.net` — marketing + docs (`apps/web`, port 3000)
- `http://localhost:3001` — self-hosted inbox (`apps/app`, `yarn dev:app`)
- iOS / Android reviewer — Expo app (`apps/mobile`, `yarn dev:mobile`)

```bash
yarn install
cp apps/app/.env.example apps/app/.env.local
yarn db:up
yarn db:migrate
yarn dev:web
yarn dev:app
yarn dev:mastra  # optional Studio demo at http://localhost:4111
```


Developer guides: `/docs`, `/integrations/http`, `/integrations/n8n`. Self-host notes: `/docs/self-host`. Implementing Hitly in an existing app: [`AGENT.md`](./AGENT.md). HTTP recipes: [`examples/n8n`](./examples/n8n/n8n.md), [`examples/notion`](./examples/notion/notion.md).

## Editions

| | Open-source server | Hitly Cloud |
| --- | --- | --- |
| License | Apache-2.0 | Proprietary |
| Inbox, projects, plugins, audit, API keys | Yes | Yes |
| Usage caps | None (self-hosted) | Plan-based |
| Stripe / SSO | Not included | Private `@hitly/cloud` overlay |

The public `@hitly/cloud` package in this repo is a stub. The hosted product replaces it via Yarn resolutions in [hitly-net/hitly-cloud](https://github.com/hitly-net/hitly-cloud).

## Monorepo

Yarn 1 workspaces + Turbo. Each package.json has `hitly.role` (`sdk` | `app` | `internal` | `edition-stub` | `example`). Only `sdk` packages (`@hitly/core`, `@hitly/plugin-*`) are future npm libraries; apps and `@hitly/cloud` are not.

Agent skills for this repo: `.cursor/skills/hitly-coding`, `.cursor/skills/hitly-release`, `.cursor/skills/hitly-deployment`.

## Database

Postgres 16 via `yarn db:up` (port **5432**). If you previously ran MariaDB, start a new volume — this schema is not a dump-and-restore from MySQL.
