# HITLy (alpha)

HITLy is the human-in-the-loop inbox for Mastra, LangGraph, Hermes Agent, HTTP / n8n / Make, and Temporal.

The origin keeps its pause. A reviewer decides in HITLy. Mastra and LangGraph resumes carry an HMAC-signed proof; HTTP, Hermes and Temporal resumes are not yet signed. Use it when an agent would send, spend, or write.

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

## Quickstart

```bash
yarn install
cp apps/app/.env.example apps/app/.env.local
yarn db:up
yarn db:migrate
yarn dev:app
```

Inbox at http://localhost:3001. `yarn db:up` starts Postgres 16 via Docker.

## Links

- [Documentation](https://hitly.net/docs)
- [Self-host guide](https://hitly.net/docs/self-host) — local run, Postgres setup, editions
- [Integrations](https://hitly.net/integrations) — [Mastra](https://hitly.net/integrations/mastra), [LangGraph](https://hitly.net/integrations/langgraph), [Hermes](https://hitly.net/integrations/hermes), [HTTP / n8n](https://hitly.net/integrations/http), [Temporal](https://hitly.net/integrations/temporal)
- [AGENT.md](./AGENT.md) — wire an existing agent
- Examples: `examples/mastra`, `examples/langgraph`, `examples/hermes`, `examples/temporal`, `examples/n8n`, `examples/notion`

Inbox: http://localhost:3001
