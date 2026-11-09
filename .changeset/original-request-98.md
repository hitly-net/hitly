---
"@hitly/app": patch
---

Reviewer inbox: "View original request" on the approval detail (hitly#98). Serves the canonical JSON of the stored create-once `hitl/request/v0` record (not the raw request bytes) with a Copy of that string and its sha256/args-hash plus the requested-event evidence anchor, so a reviewer can verify the screen against the stored original off-host (hitl-spec discussion #5). Session-authenticated reviewer access only, identical to the approval detail (unauthenticated → 401; no access → 404); the project API-key path keeps its reduced view. The view is deliberately unredacted — only ids/hashes are logged. Integers above Number.MAX_SAFE_INTEGER lose precision at ingest; that is documented, not repaired.
