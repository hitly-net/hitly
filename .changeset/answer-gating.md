---
"@hitly/core": minor
"@hitly/plugin-http": minor
"@hitly/plugin-mastra": minor
---

Enforce answer gating on approvals (hitl-spec §3.6, §3.7, §7):

- `reasonRequired`: answer values that need a reviewer reason before submit. Binary-shaped requests default to `["reject"]` when absent (spec 3.6). The approval UI prompts for the reason; the host re-validates on submit and refuses invalid answers with field errors instead of resuming the origin.
- `mustOpen`: context links/attachments can declare `mustOpen: true`. Answer controls stay locked for a reviewer until they have opened each must-open item; opens are recorded as `opened` audit events with `openedAt`, per reviewer, via the new `POST /api/v1/approvals/{id}/opens` route. The host refuses answers that skip must-open items.
- HTTP and Mastra ingest now carry `ref`, `mustOpen` and `reasonRequired` from the request body into the envelope; malformed `reasonRequired` (values that are not allowed answer values) and duplicate context refs are refused at ingest with per-field errors.

Ported from Tourbillon WID-2 (approval-card pattern); mobile UI for reason/mustOpen prompts is a follow-up — the host already refuses invalid mobile submits.
