---
"@hitly/app": patch
---

Reviewer inbox: "View original request" on the approval detail (hitly#98). Opens the stored create-once `hitl/request/v0` payload as canonical JSON with a byte-exact Copy and its sha256/args-hash plus the requested-event evidence anchor, so a reviewer can verify the screen against the stored original off-host (hitl-spec discussion #5). Session-authenticated reviewer access only, identical to the approval detail; the project API-key path keeps its reduced view. The view is deliberately unredacted (byte fidelity is the feature; access control is the control) — only ids/hashes are logged.
