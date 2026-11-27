# @hitly/mastra-factory-plugin

HITLy adapter for [Mastra Factory](https://factory.mastra.ai). Opens the three human-decision moments of a Factory session — `submit_plan`, `factory_record_review_verdict`, `ask_user` — as HITLy approvals, and applies the reviewer's decision back into the session.

Not yet on npm (see hitly-net/hitly#186). Use inside the monorepo.

## Factory host

```ts
import { MastraFactory } from '@mastra/factory'
import { createHitlyIntegration } from '@hitly/mastra-factory-plugin/factory-seams'
import { parseDeploymentConfig } from '@hitly/mastra-factory-plugin'

const factory = new MastraFactory({
  storage,
  integrations: [createHitlyIntegration(parseDeploymentConfig(process.env))],
})
```

`HITLY_PUBLIC_URL` is always required (resume callbacks point back at it). The HITLy credential vars are per-deployment *fallback* credentials — see below. For the legacy single-project wiring use `config: parseRuntimeConfig(process.env)`, which requires all of: `HITLY_API_URL`, `HITLY_API_KEY`, `HITLY_PROJECT_ID`, `HITLY_PUBLIC_URL`, `HITLY_WEBHOOK_SIGNING_SECRETS` (comma-separated project webhook signing secrets; HITLy signs resume callbacks with these). Optional: gate toggles, `HITLY_MERGE_AFTER_ACCEPT`, `HITLY_GITHUB_TOKEN`, `HITLY_POLL_INTERVAL_MS`. Resume callbacks are additionally authenticated with a per-approval bearer token issued by the plugin at gate-creation time. See [the integration guide](https://hitly.net/integrations/mastra-factory).

## Per-factory connections

Multiple Factory projects on one deployment can each route to their own HITLy project. Organization admins manage connections at **`/web/integrations/hitly/settings`**: connect (HITLy URL + API key + project id + webhook signing secret), test (read-only config read against the HITLy API), and disconnect. Credentials are encrypted at rest in Factory integration storage; saved secrets are never returned to the UI — only a masked hint.

Resolution per gate call: a factory's **saved connection wins**; otherwise, if `HITLY_ENV_FALLBACK` opts it in, the deployment's env credentials are used (the settings page badges such connections as *env fallback*); with neither, the factory produces **no HITLy items at all**.

`HITLY_ENV_FALLBACK` is opt-in: unset (default — no env credentials consulted), `all`, or a comma-separated list of factory project ids. Resume callbacks are scoped by factory (`/custom/integrations/hitly/resume/:factoryProjectId`) and a callback carrying another factory's token, signature, or approval is rejected.

## HITLy server

`@hitly/mastra-factory-plugin/server` exports the `HitlyPlugin` implementation registered for the `mastra-factory` project type. It delegates ingest/resume to `@hitly/plugin-http` and never imports `@mastra/*`, so the HITLy app does not need Factory installed.

## Hard rules

- No merge tool is exposed to agents. Merge requires both the host flag (`HITLY_MERGE_AFTER_ACCEPT` + `HITLY_GITHUB_TOKEN`) and the HITLy project toggle, re-checks the PR head SHA, and only ever runs from the HITLy-accepted review-verdict path.
- `pending`, `expired`, and `cancelled` are never approval. An expired plan declines the parked call; expiry never merges.
- `ask_user` answers are delivered verbatim via a session signal; the plugin never fabricates an answer.
- Resume callbacks are verified (bearer + HMAC signature + timestamp window + event-id dedupe) and the authoritative approval state is re-read from HITLy before anything is applied.

## Layout

| File | Role |
| --- | --- |
| `index.ts` | `HitlyMastraFactoryPlugin` — FactoryIntegration (routes, observer, diagnostics). `@mastra/*` only as types. |
| `factory-seams.ts` | Sole runtime importer of `@mastra/factory` / `@mastra/core`: `answerParkedCall`, session signals, reconciler worker. |
| `gates.ts` | Gate detection + approval request building (create-once `Idempotency-Key`). |
| `resume.ts` | Resume route: bearer + HMAC + dedupe + authoritative-state check. |
| `connections.ts` | Per-factory connection registry: resolution (saved → env fallback → none), encrypted settings, non-secret directory, client cache. |
| `settings-routes.ts` | Interim org-admin settings page + JSON API at `/web/integrations/hitly/settings`. |
| `apply.ts` | Decision matrix (plan/review/ask_user × accept/reject/edit/respond/expiry). |
| `worker.ts` | Reconciliation: polls HITLy so missed callbacks still land. |
| `merge.ts` | GitHub REST squash merge with head-SHA recheck. |
| `server.ts` | HITLy-side `HitlyPlugin` (delegates to `@hitly/plugin-http`). |

Spike evidence for the Factory seams lives in `spike/` and `docs/SPIKE.md`.
