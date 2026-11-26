# @hitly/mastra-factory-plugin

HITLy adapter for [Mastra Factory](https://factory.mastra.ai). Opens the three human-decision moments of a Factory session — `submit_plan`, `factory_record_review_verdict`, `ask_user` — as HITLy approvals, and applies the reviewer's decision back into the session.

Not yet on npm (see hitly-net/hitly#186). Use inside the monorepo.

## Factory host

```ts
import { MastraFactory } from '@mastra/factory'
import { createHitlyIntegration } from '@hitly/mastra-factory-plugin/factory-seams'
import { parseRuntimeConfig } from '@hitly/mastra-factory-plugin'

const factory = new MastraFactory({
  storage,
  integrations: [createHitlyIntegration({ config: parseRuntimeConfig(process.env) })],
})
```

Required env: `HITLY_API_URL`, `HITLY_API_KEY`, `HITLY_PROJECT_ID`, `HITLY_PUBLIC_URL`, `HITLY_WEBHOOK_SIGNING_SECRETS` (comma-separated `whsec_…` — the HITLy project webhook signing secrets that sign resume callbacks; `HITLY_WEBHOOK_SIGNING_SECRET` for a single secret). Optional: gate toggles, `HITLY_MERGE_AFTER_ACCEPT`, `HITLY_GITHUB_TOKEN`, `HITLY_POLL_INTERVAL_MS`. See [the integration guide](https://hitly.net/integrations/mastra-factory).

## HITLy server

`@hitly/mastra-factory-plugin/server` exports the `HitlyPlugin` implementation registered for the `mastra-factory` project type. It delegates ingest/resume to `@hitly/plugin-http` and never imports `@mastra/*`, so the HITLy app does not need Factory installed.

## Hard rules

- No merge tool is exposed to agents. Merge requires both the host flag (`HITLY_MERGE_AFTER_ACCEPT` + `HITLY_GITHUB_TOKEN`) and the HITLy project toggle, re-checks the PR head SHA, and only ever runs from the HITLy-accepted review-verdict path.
- `pending`, `expired`, and `cancelled` are never approval. An expired plan declines the parked call; expiry never merges.
- `ask_user` answers are delivered verbatim via a session signal; the plugin never fabricates an answer.
- Resume callbacks are verified (per-approval cbAuthToken bearer + HMAC signature with the project webhook signing secret + timestamp window + event-id dedupe) and the authoritative approval state is re-read from HITLy before anything is applied. The resume route mounts under `/custom` (`/api` is reserved by `@mastra/server`).

## Layout

| File | Role |
| --- | --- |
| `index.ts` | `HitlyMastraFactoryPlugin` — FactoryIntegration (routes, observer, diagnostics). `@mastra/*` only as types. |
| `factory-seams.ts` | Sole runtime importer of `@mastra/factory` / `@mastra/core`: `answerParkedCall`, session signals, reconciler worker. |
| `gates.ts` | Gate detection + approval request building (create-once `Idempotency-Key`). |
| `resume.ts` | Resume route: bearer + HMAC + dedupe + authoritative-state check. |
| `apply.ts` | Decision matrix (plan/review/ask_user × accept/reject/edit/respond/expiry). |
| `worker.ts` | Reconciliation: polls HITLy so missed callbacks still land. |
| `merge.ts` | GitHub REST squash merge with head-SHA recheck. |
| `server.ts` | HITLy-side `HitlyPlugin` (delegates to `@hitly/plugin-http`). |

Spike evidence for the Factory seams lives in `spike/` and `docs/SPIKE.md`.
