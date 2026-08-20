# HITLy

HITLy is the human-in-the-loop inbox for Mastra, LangGraph, Hermes Agent, HTTP / n8n / Make, and Temporal.

The origin keeps its pause. A reviewer decides in HITLy. The original run resumes with a signed payload so the model cannot approve itself. Use it when an agent would send, spend, or write.

Apache-2.0. Self-host this repo. Hosted cloud (billing, SSO) is waitlist-only at [hitly.net](https://hitly.net).

## What you can do

- Put send, spend, and write behind an inbox card, not a chat prompt
- Resume the same Mastra run, LangGraph thread, Hermes command, or HTTP Wait
- Keep an audit: requested, decided, resumed
- Review in the web inbox or the Expo app

| Origin | Pause | Resume |
| --- | --- | --- |
| Mastra | `suspend()` | `run.resume()` / `bail()` |
| LangGraph | `interrupt()` | `Command({ resume })` |
| Hermes Agent | approval transport / `kanban_block` | POST `{ decision, id, metadata }` to `resumeUrl` |
| HTTP, n8n, Make | `resumeUrl` | POST decision JSON |
| Temporal | `condition()` | signal `hitly.decision` (`workflowId`) |

Guides: [docs](https://hitly.net/docs). Samples: `examples/mastra`, `examples/langgraph`, `examples/hermes`, `examples/temporal`, `examples/n8n`, `examples/notion`.

## Self-host

Inbox at http://localhost:3001.

```bash
yarn install
cp apps/app/.env.example apps/app/.env.local
yarn db:up
yarn db:migrate
yarn dev:app
```

Optional: `yarn dev:web` (marketing/docs on :3000), `yarn dev:mobile` (Expo reviewer), `yarn dev:mastra` (Studio demo on :4111).

Postgres 16 via `yarn db:up` (port 5432). Full notes: [Self-host](https://hitly.net/docs/self-host). Wire an existing agent: [AGENT.md](./AGENT.md).

## Editions

| | Open-source server | HITLy Cloud |
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
