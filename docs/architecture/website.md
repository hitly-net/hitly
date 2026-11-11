# Website (`apps/web`)

## Purpose

The public `hitly.net` site: marketing pages plus the documentation site.
It is not part of the approval data path; it exists to explain and sell the
product and to serve machine-readable surfaces for agents.

## Where it lives

- `apps/web/app/` - marketing routes: root landing page, `pricing`,
  `integrations` (per-origin pages), `cloud` (a waitlist placeholder for the
  hosted edition; not indexed), `privacy`, `terms`.
- `apps/web/app/docs` - fumadocs-powered documentation; content lives in
  `apps/web/content/docs` with navigation defined in `content/docs/meta.json`
  (index, self-host, inbox, envelope, trace, s3, api, mcp, projects,
  governance, mobile).
- `apps/web/app/agents.md`, `agents.txt`, `llms.txt`, `llms-full.txt` -
  agent-readable surfaces; `llms.txt` is generated from the docs sources.
- `apps/web/app/robots.ts`, `sitemap.ts` - crawl policy and sitemap.
- `apps/web/app/api/waitlist` - waitlist form endpoint.
- `apps/web/lib/` - site helpers (e.g. agents content builder).

## Key interfaces

- Static/marketing pages rendered by Next.js.
- Documentation content as MDX under `content/docs`.
- `POST` waitlist submissions forwarded to `WAITLIST_WEBHOOK_URL`.

## How it talks to the others

- Links into the hosted/installed web app using `NEXT_PUBLIC_APP_URL`; it
  holds no database connection of its own.
- The `cloud` page presents HITLy Cloud as a waitlist-only, not-yet-GA
  hosted edition (see [cloud.md](cloud.md)); it never exposes hosted
  endpoints.

## Configuration (variable names only)

`NEXT_PUBLIC_APP_URL`, `WAITLIST_WEBHOOK_URL`.

## Unconfirmed

- Where the waitlist webhook delivers (external service, not in this repo).
