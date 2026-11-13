# Export your data (GDPR)

Signed-in users can download a copy of their personal data at any time:
**Settings → Profile → Your data → Export my data**. The download is a ZIP
archive of JSON files, produced on the spot from the live database.

## What the archive contains

| File | Contents |
| --- | --- |
| `profile.json` | name, email, verification state, avatar URL, timestamps |
| `sessions.json` | your sign-in sessions: device user-agent, client IP, timestamps (never the session token) |
| `accounts.json` | which auth providers are linked (Google, password, …) — provider name and scope only, never password hashes or OAuth tokens |
| `workspaces.json` | the workspaces you belong to and your role in each |
| `projects.json` | the projects you belong to: name, plugin, your role (never credentials, rules or channel config) |
| `approvals.json` | approval requests you were assigned, were shown, or decided: title, reviewer prompt/context, status, timestamps, and **your own** decision, reason and answer only |
| `devices.json` / `pushTokens.json` | your registered devices (platform and a short token prefix, never the raw push token) |
| `sentInvites.json` | workspace invites you sent |
| `securityEvents.json` | your account-security event log (MFA enrol/disable, exports, …) |
| `manifest.json` | generation timestamp, row counts per file, `truncated` flag |

Deliberately excluded: secrets (password hashes, OAuth tokens, session
tokens, raw push tokens, project API keys, project credentials), raw request
payloads, evidence blobs, and other users' comments or contact details.
Workspace-owned records (approvals, evidence) stay with the workspace.

## Limits

- One export per hour per account (a repeat within the window returns
  HTTP 429 with a `Retry-After` header).
- At most 10,000 rows per table and ~25 MB per archive; when a table is
  capped, `manifest.json` sets `"truncated": true`.
- Requires a signed-in session and a same-origin web request.
- Every successful export is recorded in your security-event log.

Self-hosted operators: the feature needs no configuration; it runs inside
the existing app server (`POST /api/session/export`).
