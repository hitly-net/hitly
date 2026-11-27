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

## Factory Settings → Connections card (interim)

Factory has no extension point for its Settings → Connections screen yet ([hitly-net/hitly#211](https://github.com/hitly-net/hitly/issues/211); UI plan approval in [#212](https://github.com/hitly-net/hitly/issues/212)), so until upstream ships one this plugin contributes a **HITLy card** through a version-guarded, reversible post-build overlay of the **built** SPA. It does **not** fork `@mastra/factory`, does not edit the SPA's source or its minified chunks, and does not change how Factory encrypts integration settings.

The card shows the current factory's HITLy status (`Connected` / `Not connected` / `Env fallback`) and links to `/web/integrations/hitly/settings`. It is visible to organization admins only — the card API sits behind the same `ensureUser → tenant → isOrganizationAdmin` check as the settings page, and it never returns a secret (status text is derived from the same masked projection the settings API uses).

**How it works:** plugins register a card server-side with `registerConnectionCard()` (`src/connection-cards.ts`, kept generic so any installed connection plugin can contribute a card — HITLy is just the first). A small bootstrap (`src/connections-boot.ts`) is loaded by a `<script>` tag injected into the built `index.html`; it waits for the Connections screen, fetches `GET /web/integrations/hitly/settings/cards`, and renders the cards with `textContent` only. A card that throws or exceeds its 2 s budget is dropped with a `warn` and cannot break the page.

**Apply after building/deploying the Factory app** (there is deliberately no `postinstall` hook — it would fire in CI and in consumers that never deploy Factory):

```bash
yarn workspace @hitly/mastra-factory-plugin patch:factory-ui   # inject
yarn workspace @hitly/mastra-factory-plugin check:factory-ui   # verify (--check, exits 1 when stale/absent)
npx tsx packages/mastra-factory-plugin/scripts/patch-factory-ui.ts --revert   # remove
```

The CLI writes **only** its marker block (`<!-- hitly:connection-cards:start|end -->`) into `index.html`, resolves the built SPA from `--index <file>`, `--dist <dir>`, `MASTRACODE_UI_DIST`, `./factory`, or `./src/mastra/public/factory`, and is idempotent (re-running replaces a stale block instead of stacking).

**Version guard:** the patch is validated against `PINNED_FACTORY_UI_VERSION` (`0.30.0`) and the `devDependencies['@mastra/factory']` pin is kept equal to it by a test. If the installed `@mastra/factory` is missing or any other version, the CLI logs one warning and leaves the Factory UI **untouched** (exit 0) — upgrade path is to re-validate, bump `PINNED_FACTORY_UI_VERSION`, or pass `--force` after checking the screen yourself. The direct settings URL works regardless of whether the patch is applied.

**Off-switch:** `HITLY_FACTORY_UI_PATCH=0` (also `false`/`off`/`no`) makes the CLI skip and the server 404 `boot.js`, so an already-injected tag simply loads nothing. Other knobs: `HITLY_CONNECTION_CARDS_ANCHOR` (extra CSS selector for the Connections anchor) and `cardTimeoutMs` on the settings routes.

**Removal path, once upstream ships the extension point:** revert on deployed hosts, then delete `src/connection-cards.ts`, `src/hitly-connection-card.ts`, `src/connections-boot.ts`, `src/patch-factory-ui.ts`, `scripts/patch-factory-ui.ts`, the `patch:factory-ui` / `check:factory-ui` scripts, the `/cards` and `/boot.js` routes in `settings-routes.ts`, and this section.

## HITLy server

`@hitly/mastra-factory-plugin/server` exports the `HitlyPlugin` implementation registered for the `mastra-factory` project type. It delegates ingest/resume to `@hitly/plugin-http` and never imports `@mastra/*`, so the HITLy app does not need Factory installed.

## Hard rules

- No merge tool is exposed to agents. Merge requires both the host flag (`HITLY_MERGE_AFTER_ACCEPT` + `HITLY_GITHUB_TOKEN`) and the HITLy project toggle, re-checks the PR head SHA, and only ever runs from the HITLy-accepted review-verdict path.
- `pending`, `expired`, and `cancelled` are never approval. An expired plan declines the parked call; expiry never merges.
- `ask_user` answers are delivered verbatim via a session signal; the plugin never fabricates an answer.
- Resume callbacks are verified (bearer + HMAC signature + timestamp window + event-id dedupe) and the authoritative approval state is re-read from HITLy before anything is applied.
- A gate answered on the Factory side closes its HITLy item as decided-elsewhere (requester cancel) instead of staying pending. A later HITLy decision on that gate is never applied: it is reported as a conflict.
- Gate state (open / decided in Factory / applied from HITLy / conflict) is persisted through the host's integration storage, so a restart cannot resurrect a gate that is already closed.
- The tool pipeline never waits on HITLy: the observer queues its gate work and returns, and every HITLy request carries a deadline (`requestTimeoutMs`, default 10s), so a wedged HITLy cannot hold a parked tool call open.

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
| `gate-state.ts` | Per-gate record (open / decided-in-Factory / applied-from-HITLy / conflict), the requester-cancel close, conflict detection. |
| `worker.ts` | Reconciliation: polls HITLy so missed callbacks still land. |
| `merge.ts` | GitHub REST squash merge with head-SHA recheck. |
| `server.ts` | HITLy-side `HitlyPlugin` (delegates to `@hitly/plugin-http`). |

Spike evidence for the Factory seams lives in `spike/` and `docs/SPIKE.md`.
