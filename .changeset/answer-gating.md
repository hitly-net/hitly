---
"@hitly/core": minor
"@hitly/plugin-http": minor
"@hitly/plugin-mastra": minor
---

Enforce answer gating on approvals (hitl-spec §3.6, §3.7, §7):

- `reasonRequired`: answer values that need a reviewer reason before submit. Binary-shaped requests default to `["reject"]` when the field is absent (spec 3.6); an explicitly sent `reasonRequired: []` is now kept as `[]` by HTTP and Mastra ingest, so callers can opt out of that default. The web approval UI prompts for the reason, and the mobile app now prompts for a required reason and sends `reason` with the decision. The host re-validates on submit and refuses invalid answers with field errors instead of resuming the origin.
- `mustOpen`: context links/attachments can declare `mustOpen: true`. Answer controls stay locked for a reviewer until they have opened each must-open item; opens are recorded as `opened` audit events with `openedAt`, per reviewer, via the new `POST /api/v1/approvals/{id}/opens` route. The host refuses answers that skip must-open items. The mobile app now shows the must-open checklist and records opens through that route (context links/attachments route through the opens API too).
- HTTP and Mastra ingest now carry `ref`, `mustOpen` and `reasonRequired` from the request body into the envelope; malformed `reasonRequired` (values that are not allowed answer values) and duplicate context refs are refused at ingest with per-field errors.
- API note (minor): callers rejecting a binary accept/reject request without a reason now get HTTP 400 with a `fields` array of per-field errors instead of the answer being accepted.
