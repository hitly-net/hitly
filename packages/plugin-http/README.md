# @hitly/plugin-http

Generic HTTP callback adapter: ingest a payload with `resumeUrl`, resume by POSTing the decision JSON plus ingest `metadata`. n8n Wait nodes, Notion automations, Make, and custom webhooks all use this plugin id.

## Answer gating (hitl-spec 3.6/3.7)

Ingest envelopes may gate the answer:

- `reasonRequired: ["reject", …]` — answer values that need a non-empty `reason`
  (binary accept/reject requests default to `["reject"]` when the field is absent;
  an explicit `[]` opts out).
- `externalUrls[]` / `attachments[]` entries carry an optional `ref` (gating key) and
  `mustOpen: true`. Until the deciding reviewer recorded an open for every must-open
  item, the host refuses acting answers (accept/reject/edit/respond). Ignore/dismiss
  is exempt — it takes no action and does not require opens.

The resume POST carries the reviewer's fields verbatim: `decision`, `response`,
`reason` (typed reason, untrimmed), `editedArgs`, `editReason`, `editReasonText`.
Reviewer clients report opens via `POST /api/v1/approvals/:id/opens` (see
`docs/mobile.md`, *Decide & answer gating*).
