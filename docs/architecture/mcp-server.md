# MCP server (`apps/mcp`)

## Purpose

A standalone Model Context Protocol server that lets an LLM (acting as a
tool-using agent) ask a human for approval without the host web app being in
the loop for the ask itself. It speaks Streamable HTTP on a `/mcp` path and
translates MCP tool calls into calls against the HITLy host REST API. It
never stores approvals itself: the host is the source of truth.

## Where it lives

- `apps/mcp/src/main.ts` - entry point: loads config, starts the HTTP server.
- `apps/mcp/src/server.ts` - request pipeline: API-key extraction and
  shape validation, host-header/Origin checks, rate limiting, browser
  redirect (a plain browser visit to `/mcp` is sent to the public docs page),
  session routing.
- `apps/mcp/src/tools.ts` - the MCP tool surface, registered on
  `@modelcontextprotocol/sdk`.
- `apps/mcp/src/host-client.ts` - `HttpHostClient`, the typed client for the
  host REST API.
- `apps/mcp/src/config.ts` - env parsing; all runtime config comes from env
  so one build runs behind any reverse proxy.
- `apps/mcp/src/security.ts`, `rate-limit.ts`, `logger.ts`, `jcs.ts`,
  `answer-types.ts`, `origin.ts`, `auth*` and related tests.

## Key interfaces (MCP tools)

| Tool | Behavior |
| --- | --- |
| `request_approval` | Create an Approve/Reject/Ignore ask; returns immediately (`pending`), never blocks. Optional `callback_url`; without it no callback is ever attempted. |
| `ask_user` | Ask a typed question; the reviewer's typed answer (`answer {kind, value}`) comes back through `get_decision`. One ask per request. |
| `get_decision` | Non-blocking read returning the hitl/response/v0 document (`pending`, `answered`, `declined`, `cancelled`, `expired`). |
| `list_pending` | Key-scoped list of open requests with cursor paging. |
| `cancel` | Withdraw an open request created by the same credential. |

Authentication: `Authorization: Bearer <project API key>`; the server
validates the key's shape (rejecting resume tokens) and forwards it to the
host, which is the authority on validity and scope. Per-key rate limiting is
enforced locally.

## How it talks to the others

- `apps/app` REST API via `HttpHostClient`: `POST /api/v1/approvals` (with
  an idempotency key), `GET /api/v1/approvals/{id}`, the key-scoped pending
  list, and `POST /api/v1/approvals/{id}/cancel`.
- Reviewers indirectly: the host sends their email/push notifications; the
  MCP server only polls/returns state.
- `packages/core`-adjacent rules are mirrored (deadline defaults are kept in
  lockstep with the host's request window; JCS for event hashing).

## Configuration (variable names only)

`HITLY_MCP_HOST`, `HITLY_MCP_PORT`, `HITLY_MCP_PUBLIC_URL`,
`HITLY_MCP_ALLOWED_ORIGINS`, `HITLY_MCP_RATE_LIMIT`,
`HITLY_MCP_RATE_LIMIT_WINDOW_MS`, `HITLY_API_URL`, `HITLY_APP_URL`,
`HITLY_HOST_CAPABILITIES`.

Defaults from code: loopback bind, port value in `config.ts`, `/mcp` path,
per-key request budget per window. `HITLY_HOST_CAPABILITIES` gates host
features (for example callback Bearer auth, host-honored deadlines) until the
host supports them; the server then refuses instead of pretending.

## Unconfirmed

- Whether a stdio transport is offered anywhere (the code in this repo is
  HTTP-only).
