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
- Default deadline is **24 hours**. Expiry, cancel and pending are never approval.
- `callback_url` and links must be `https`. The server never fetches links.
- `argsHash` = `b64url(SHA-256(JCS(action.args)))` over the original args. The stored request never changes; a reviewer amendment arrives only as `editedArgs` in the decision, and the bot must act on `editedArgs` when present.
- Poll `get_decision` politely (every 30–60 s while pending, backing off) if you cannot take callbacks. The callback is a hint; `get_decision` is the source of truth.

## Auth

`Authorization: Bearer hitly_…` — a HITLy **HTTP-plugin project API key**, forwarded to the host for every call. Missing or malformed keys get `401` with `WWW-Authenticate: Bearer`. OAuth 2.1 replaces key paste in M3.

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
| `HITLY_MCP_PUBLIC_URL` | unset | Public origin of this server. When set, requests without `callback_url` use `<origin>/callbacks/noop` (HTTP ingest requires a `resumeUrl`); when unset, `callback_url` is required. |
| `HITLY_HOST_CAPABILITIES` | empty | Comma list of host features to use once they ship: `cb_auth_token` (M0h Bearer callbacks), `expires_at` (M0 honours the deadline). |

`GET /healthz` returns `{"status":"ok"}`. The server is stateless: create-once lives on the host, so restarts lose nothing.

## Depends on M0 / M0h

The adapter (`src/host-client.ts`) already targets the endpoints below; tests marked `[M0]` / `[M0h]` run against a fake host with that shape.

- **M0:** key-scoped pending list; requester cancel with a project key; `hitl/response/v0` fields on API-key reads (`reason`, `decidedBy`, `decidedAt`, `argsHash`, `editedArgs`, `answer`, `activity`); replay of closed requests; host honouring `expiresAt` (today the project SLA sets expiry).
- **M0h:** `cb_auth_token` Bearer on callbacks (refused until `HITLY_HOST_CAPABILITIES=cb_auth_token`), HMAC, lifecycle events, typed answers for `ask_user`.
