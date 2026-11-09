# @hitly/mcp — HITLy MCP server (M1)

Remote [MCP](https://modelcontextprotocol.io) server that lets a bot ask a human (on HITLy web or mobile) for an approval or an answer. Streamable HTTP at **`/mcp`** (hosted as `https://mcp.hitly.net/mcp`). Async-first: every create returns immediately with `state: "pending"`; there is no wait or long-poll.

## Tools

| Tool | What it does | Host call |
| --- | --- | --- |
| `request_approval` | Approve / Reject / Ignore an action. Returns `requestId`, `state`, `replayed`, `argsHash`, `deadline`, `reviewUrl`. | `POST /api/v1/approvals` (HTTP plugin; `callback_url` → `resumeUrl`; `Idempotency-Key` = `idempotencyKey`) |
| `ask_user` | Ask a question with an `answerSchema` (`free_text`, `single_choice`, `multi_choice`, `simple_form`). Optional markdown `detail` (≤8000 chars) renders under the headline. | same ingest, `kind: "question"` |
| `get_decision` | Non-blocking read as `hitl/response/v0`. Returns `editedArgs` when the reviewer amended the action. | `GET /api/v1/approvals/:id` |
| `list_pending` | Open requests created with this key. | `GET /api/v1/approvals?status=pending` (M0) |
| `cancel` | Withdraw an open request. | `POST /api/v1/approvals/:id/cancel` (M0 requester cancel) |

There is **no decide tool**. Requester credentials can request, read and cancel only; decisions come from a signed-in human on web or mobile.

Rules the server enforces:

- `question` (and the `ask_user` `prompt` headline) is one sentence, at most 160 characters, ending with `?` (hitl-spec 3.1/3.3). Detail goes in `context`, or in `ask_user`'s optional markdown `detail` (at most 8000 characters), which renders under the headline.
- Deadline is an ISO 8601 date-time, must be in the future, and at most **30 days** out; the default is **24 hours**. A past or over-cap deadline is refused with an `invalid_request` tool error. Expiry, cancel and pending are never approval. A replay of the same `idempotencyKey` reports the deadline stored on create, never a recomputed one.
- `requestId` must match `[A-Za-z0-9_-]{1,64}` (no `.`, `..` or `/`).
- A host read that claims `decision: "edit"` without `editedArgs` fails closed: `get_decision` reports `declined`, never an approval.
- JSON-RPC bodies over 1 MiB are refused with `413`.
- `callback_url` and links must be `https`. The server never fetches links.
- Caller-supplied `decision`, `editedArgs`, `projectId`, `plugin`, `resumeUrl` or any other extra tool field never reaches the host ingest; `plugin`, `resumeUrl` and `allowedActions` are server-controlled.
- `argsHash` = `b64url(SHA-256(JCS(action.args)))` over the original args. The stored request never changes; a reviewer amendment arrives only as `editedArgs` in the decision, and the bot must act on `editedArgs` when present.
- Poll `get_decision` politely (every 30–60 s while pending, backing off) if you cannot take callbacks. The callback is a hint; `get_decision` is the source of truth.

## Auth

`Authorization: Bearer hitly_…` — a HITLy **HTTP-plugin project API key**, forwarded to the host for every call. Missing or malformed keys get `401` with `WWW-Authenticate: Bearer`. OAuth 2.1 replaces key paste in M3.

## Origin, Host and rate limiting

- **Origin** (MCP spec MUST): a request to `/mcp` with no `Origin` header (server-to-server) is allowed. A present `Origin` must be a loopback origin while the server is bound to loopback, be listed in `HITLY_MCP_ALLOWED_ORIGINS`, or equal the `HITLY_MCP_PUBLIC_URL` origin. Anything else (e.g. `https://evil.example`) is refused with `403` before the credential is considered.
- **Host** while bound to loopback: the `Host` header must name a loopback host (`127.0.0.1`, `localhost`, `::1`); other hosts get `403` (DNS-rebinding defence). The check is skipped when `HITLY_MCP_HOST` binds a public interface.
- **Rate limit:** each API key gets `HITLY_MCP_RATE_LIMIT` requests per `HITLY_MCP_RATE_LIMIT_WINDOW_MS` (default 120 per 60 s). Over the budget, `/mcp` answers `429` with `Retry-After` (seconds). Unauthenticated 401s consume no key budget. Set `HITLY_MCP_RATE_LIMIT=0` to disable (not recommended in public).

## Logging

Logs are JSON lines with only `event`, `tool`, `requestId`, `status`, `latencyMs`, `clientId` (a truncated SHA-256 of the key) and `port`. Questions, prompts, detail, context, args, reasons, answers, callback URLs, tokens and host error text are never logged.

## Run

```sh
yarn workspace @hitly/mcp start
```

| Env | Default | Meaning |
| --- | --- | --- |
| `HITLY_MCP_HOST` | `127.0.0.1` | Listen address. Set to the interface the reverse proxy reaches. |
| `HITLY_MCP_PORT` | `3006` | Listen port. The proxy for `mcp.hitly.net` targets this configurable `host:port`. |
| `HITLY_API_URL` | `https://cloud.hitly.net` | HITLy host the server calls. |
| `HITLY_APP_URL` | `HITLY_API_URL` | Base for `reviewUrl` (`/inbox/:id`). |
| `HITLY_MCP_PUBLIC_URL` | unset | Public origin of this server. When set, requests without `callback_url` use `<origin>/callbacks/noop` (HTTP ingest requires a `resumeUrl`); when unset, `callback_url` is required. Its origin is always allowed on `/mcp`. |
| `HITLY_MCP_ALLOWED_ORIGINS` | empty | Comma-separated http(s) origins (no path) additionally allowed on `/mcp`, e.g. `https://bot.example,http://localhost:8080`. |
| `HITLY_MCP_RATE_LIMIT` | `120` | Requests per key per window; `0` disables. |
| `HITLY_MCP_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds. |
| `HITLY_HOST_CAPABILITIES` | empty | Comma list of host features to use once they ship: `cb_auth_token` (M0h Bearer callbacks), `expires_at` (M0 honours the deadline). |

`GET /healthz` returns `{"status":"ok"}`. The server is stateless: create-once lives on the host, so restarts lose nothing.

## Depends on M0 / M0h

The adapter (`src/host-client.ts`) already targets the endpoints below; tests marked `[M0]` / `[M0h]` run against a fake host with that shape.

- **M0:** key-scoped pending list; requester cancel with a project key; `hitl/response/v0` fields on API-key reads (`reason`, `decidedBy`, `decidedAt`, `argsHash`, `editedArgs`, `answer`, `activity`); replay of closed requests; host honouring `expiresAt` (today the project SLA sets expiry).
- **M0h:** `cb_auth_token` Bearer on callbacks (refused until `HITLY_HOST_CAPABILITIES=cb_auth_token`), HMAC, lifecycle events, typed answers for `ask_user`.
