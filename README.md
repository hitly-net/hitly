# Hitly

Apache-2.0 human-in-the-loop inbox for Mastra, n8n, LangGraph, and Temporal.

Self-host this repo, or use the hosted product at [hitly.net](https://hitly.net). Cloud-only features (Stripe billing, usage metering, SSO) live in a private overlay package — they are not env-var flags in this tree.

- `hitly.net` — marketing + docs (`apps/web`, port 3000)
- `app.hitly.net` — product (`apps/app`, port 3001)

```bash
yarn install
yarn dev:web
yarn dev:app
```

Copy `apps/app/.env.example` to `apps/app/.env.local` and set `DATABASE_URL` for Better Auth.

Developer guides: `/docs` and `/integrations/mastra`. Self-host notes: `/docs/self-host`.

## Editions

| | Open-source server | Hitly Cloud |
| --- | --- | --- |
| License | Apache-2.0 | Proprietary |
| Inbox, plugins, audit, API keys | Yes | Yes |
| Usage caps | None (self-hosted) | Plan-based |
| Stripe / SSO | Not included | Private `@hitly/cloud` overlay |

The public `@hitly/cloud` package in this repo is a stub. The hosted product replaces it via Yarn resolutions in [hitly-net/hitly-cloud](https://github.com/hitly-net/hitly-cloud).

## Monorepo

Yarn 1 workspaces + Turbo. Packages: `@hitly/core`, `@hitly/db`, `@hitly/ui`, `@hitly/cloud`, `@hitly/plugin-*`.
