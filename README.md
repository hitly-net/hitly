# Hitly

Apache-2.0 human-in-the-loop inbox for Mastra, n8n, LangGraph, and Temporal.

Self-host this repo, or use the hosted product at [hitly.net](https://hitly.net). Cloud-only features (Stripe billing, usage metering, SSO) live in a private overlay package — they are not env-var flags in this tree.

- `hitly.net` — marketing + docs (`apps/web`, port 3000)
- `app.hitly.net` — product (`apps/app`, port 3001)
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


Developer guides: `/docs` and `/integrations/mastra`. Self-host notes: `/docs/self-host`. Implementing Hitly in an existing app: [`AGENT.md`](./AGENT.md).

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
