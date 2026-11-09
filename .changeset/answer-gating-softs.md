---
"@hitly/core": patch
"@hitly/plugin-hermes": patch
"@hitly/plugin-openshell": patch
"@hitly/plugin-temporal": patch
"@hitly/app": patch
"@hitly/mobile": patch
---

Answer-gating follow-ups from the hitly#96 Test gate:

- Evidence: the decided event's `oversight` block now carries the reviewer's typed `reason` alongside `response`/`edit_reason` (`EvidenceOversight.reason`, hitl-spec 4.1).
- Web: the typed `reason` is stored and forwarded verbatim (trimming only for the emptiness check); a host refusal no longer loses what the reviewer typed, and a failed opens report shows a retry notice instead of swallowing the error (middle-click opens are recorded too).
- Web/mobile: `mustOpen` gates every answer consistently, `ignore` included, matching the host rule (pinned by core tests). `GET /api/v1/approvals/{id}` now returns `openedRefs`, the requesting reviewer's recorded opens, and the mobile must-open checklist hydrates from them.
- Mobile: the reason sheet keeps the typed reason when a submit is refused or fails.
- Hermes, OpenShell and Temporal plugins forward the reviewer's `reason` on resume.
- Docs: `docs/mobile.md` gains *Decide & answer gating* and *Open a context item* sections (decide body, `reason`, 400 `fields`, `ref`/`mustOpen`/`reasonRequired`, opens API); the plugin-http README documents the gating fields and the resume payload.
