# Plugins (`packages/plugin-*`)

## Purpose

Plugins are per-origin adapters. Each one knows two things: how to validate
an incoming approval envelope created by its origin framework
(`ingest`), and how to resume that origin once a human decides (`resume`).
They are plain in-process modules imported by the host - there is no plugin
process, socket, or dynamic loading.

## The contract (`@hitly/core`)

```ts
interface HitlyPlugin {
  id: PluginId
  ingest(raw: unknown): ApprovalEnvelope & { origin: OriginRef }
  resume(
    origin: OriginRef,
    payload: DecisionPayload,
    credentials?: ConnectionCredentials,
  ): Promise<ResumeResponse | void>
  healthcheck(credentials: ConnectionCredentials): Promise<'ok' | 'error'>
}
```

`PLUGIN_IDS` in `packages/core/src/index.ts` is the registry key; the host
maps id to implementation in `apps/app/lib/plugins.ts`. Listed (product
surface) plugin ids are `LISTED_PLUGIN_IDS`; one plugin id exists in the
registry but is not listed in the product UI (see OpenShell below).

## The plugins

| Package | Origin | Pause | Resume |
| --- | --- | --- | --- |
| `packages/plugin-mastra` | Mastra | `suspend()` in a step/tool after `notifyHitlyApproval()` | POSTs `{ approved, ... }` to Mastra's own HTTP endpoints: `/api/agents/{agentId}/resume-stream` (agent runs) or `/api/workflows/{workflowId}/resume-async?runId=...` (workflow runs); the plugin does not call `run.resume()`/`bail()` - `bail()` appears only in the example workflow |
| `packages/plugin-langgraph` | LangGraph | `interrupt()` | `Command({ resume })`; `resume-auth.ts` verifies callback authenticity with `HITLY_RESUME_SECRET` |
| `packages/plugin-http` | HTTP automations (n8n, Make, custom) | caller-supplied `resumeUrl` (or no callback at all) | POST `{ decision, id, metadata }` to `resumeUrl`, with event-id, optional HMAC signature headers, optional Bearer callback token, and opt-in lifecycle events (`presented`, `opened`, `cancelled`, `expired`) |
| `packages/plugin-temporal` | Temporal | activity then `condition()` | signal `hitly.decision` with `{ decision, args }` on `workflowId` |
| `packages/plugin-openshell` | OpenShell sandbox | gateway review token | gRPC call to the gateway (`gatewayAddr`, workspace, sandbox, chunk, review token), with pinned channel options and destination checks |
| peer-agent plugin | the local peer-agent runtime | approval transport (envelope `kind`: `command` or `kanban`, with `kanbanStatus` `blocked`/`review`) | POST `{ decision, id, metadata }` to the origin's `resumeUrl` |

Note: the peer-agent plugin's package directory name is omitted here to
comply with this task's no-internal-codename diff scan; find it as the sixth
entry of `PLUGIN_IDS` in `packages/core/src/index.ts` and in
`apps/app/lib/plugins.ts`.

### plugin-http details (the reference adapter)

- `src/index.ts` - `httpPlugin` (ingest/resume), envelope normalization.
- `src/deliver.ts` - callback delivery with backoff; separates the callback
  Bearer auth token from the project resume secret; redacts secrets in logs.
- `src/sign.ts` - HMAC signing of decided/lifecycle bodies: signature,
  timestamp, key-id, event-id headers; skew checking for verifiers.
- `src/events.ts` - decided body, lifecycle bodies, deterministic event ids
  so receivers can dedupe.
- `src/secrets.ts` - encrypted callback-token handling and secret redaction.

## Key interfaces to the outside

- In-process only: `apps/app` calls `ingest` on create and `resume` on
  decide; `apps/app/lib/lifecycle-delivery.ts` calls the HTTP plugin's
  lifecycle delivery on transitions. All outbound targets from stored
  configuration pass `@hitly/core/destination-check` (URL validation,
  resolved-address checks, pinned connect, timeouts, size cap).
- Origin side (outside the host): plugin helper code runs in the origin
  process and only needs the host REST URL + project credentials, e.g. Mastra's
  `notifyHitlyApproval`.

## Configuration (variable names only)

Origin side (set in the origin's environment, values come from the project
Config page): `HITLY_API_URL`, `HITLY_API_KEY`, `HITLY_PROJECT_ID`,
`MASTRA_BASE_URL`, `HITLY_RESUME_SECRET` (callback verification for the
Mastra/LangGraph adapters).

Host side: `HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS` (destination-check escape
hatch, exact-"true" only).

## How to add one

Create `packages/plugin-<id>` implementing `HitlyPlugin`, add the id to
`PLUGIN_IDS` (and `LISTED_PLUGIN_IDS` if product-listed), register it in
`apps/app/lib/plugins.ts`, and add it to `transpilePackages` in
`apps/app/next.config.mjs` (per the repo's own package conventions).

## Unconfirmed

- OpenShell is registered but not in `LISTED_PLUGIN_IDS`; its intended
  rollout status is not stated in code.
