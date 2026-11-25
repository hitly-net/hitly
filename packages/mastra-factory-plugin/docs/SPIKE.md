# Phase 1 spike — `@mastra/factory` 0.31.0 integration seams

Date: 2026-11-25. Host: `@mastra/factory@0.31.0` (exact pin), `@mastra/libsql@1.32.0`, Node 22.
Scripts (kept runnable): `npx tsx spike/01-mount.ts`, `spike/02-answer-parked.ts`, `spike/03-signal.ts`.
All three PASS.

## Proven seams

| Need | Seam | Verdict |
| --- | --- | --- |
| Register plugin with Factory | `new MastraFactory({ storage, auth: null, integrations: [integration] })` → `prepare()` | Works with LibSQL in-memory; no network, no model keys needed for mount. `shutdown()` exists and is clean. |
| Persist plugin state (dedupe, config cache) | `initialize({ storage })` receives an `IntegrationStorageHandle` scoped to the integration id (`connections`, `subscriptions`, `settings`) | Use `settings` for gate cache + event-id dedupe. |
| HTTP surface (resume route) | `routes(ctx): ApiRoute[]` (Hono-style `{ path, method, requiresAuth, handler }`) | Called at boot; folded into the server route table. |
| Gate detection | `postToolObserver` | Called per tool call; GitHub integration uses it to detect `gh pr create` (stdout scan) and `source_control_create_change_request` (output.url). Errors are caught/logged by Factory — non-blocking. |
| Background poller | `workers(ctx): MastraWorker[]` | Collected into `MastraArgs.workers` in `prepare()`; `MastraWorker` from `@mastra/core/worker` (`init/deps`, `start`, `stop`, `isRunning`). |
| Apply plan decision | `answerParkedCall` via deep import `@mastra/factory/tools/approval-tools` | Gate channel → `respondToToolApproval({decision, toolCallId, requestContext, declineContext})`. Resume channel → `claimToolSuspension` → `respondToToolSuspension({resumeData:{action:'approved'|{action:'rejected',feedback}}, address})` → `releaseToolResponse`. `declineReason` is required even for `approve` at the type level. |
| Deliver answers/verdicts to session | `deliverFactorySessionNotification` + `resolveSessionThread` via `@mastra/factory/tools/deliver` | Returns `woken` / `mid-run` / `summarized` / `skipped` / `persisted`. Tags `source: FACTORY_SESSION_NOTIFICATION_SOURCE`. `resolveSessionThread` prefers the active work-item run binding. |

## Critical findings (shape the implementation)

1. **`ask_user` has no typed-answer seam.** `resumesOnDecision` admits a suspension to the
   approval channel only when its `resumeSchema` is a bare `{action: approved|rejected}`
   object. Free-text schemas (the `ask_user` shape) are invisible to `answerParkedCall` —
   spike case 5 proves the call rejects with "Nothing is waiting on that tool call".
   **The plan's fallback is mandatory, not optional: typed answers go verbatim via
   `deliverFactorySessionNotification`.**
2. **Deep imports must omit `.js`.** The exports map `"./*": "./dist/*.js"` double-appends
   the extension: `@mastra/factory/tools/approval-tools.js` → ERR_MODULE_NOT_FOUND
   (`approval-tools.js.js`). Use `@mastra/factory/tools/approval-tools`.
3. **Sync/async exactness for fakes**: `live.approval.list()` and `live.displayState.get()`
   are synchronous; `claimToolSuspension` is synchronous; `respondToToolApproval` returns
   `{accepted, reason?}` synchronously. Tests that fake a live session must match.
4. **Cold-session signal delivery requires `controller.createSession`** (via
   `createSessionAsRowOwner`); a real mounted controller provides it. Offline+`onlyIfLive`
   → `{delivered:'skipped', reason:'offline'}`; missing row → `session-not-found`.
5. **`IntegrationContext` at prepare() time** carries: `auth, baseUrl, controller,
   factoryStorage, hooks, runtime, sandbox, stateSigner, storage, workItems`.
   (`ctx.controller` is present pre-mount — the webhook→session signal path.)
6. **Ready-gating**: an integration is only wired if `storage.isDomainReady('integrations')`
   (+`source-control` when `versionControl`, +`channel-identity` when `channels`). The
   built-in LibSQL/Pg factory storages satisfy `integrations`.
7. **Tool-name collisions** between integrations are resolved first-wins with a console
   warning; the plugin must namespace any tools it exposes (e.g. `hitly_*`).
8. **Weekly-minor upstream churn**: no public docs for the `FactoryIntegration` seam;
   `dist/integrations/base.d.ts` + built-in integrations are authoritative. Keep all
   Factory-touching imports inside `src/factory-seams.ts` so upgrades are one audited file.

## Deferred to pilot (documented, not blocking)

Full `new Mastra(prepare()) + finalize()` boot with a real project/session and a parked
tool is heavier than a spike (sandbox + auth + DB). Phase 3–5 unit tests use the fakes
proven here; the pilot validates end-to-end on the Mastra cloud Factory.
