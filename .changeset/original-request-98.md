---
"@hitly/app": patch
---

Reviewer inbox: "View original request" on the approval detail (hitly#98). Serves the stored create-once `hitl/request/v0` record (redacted canonical JSON) with Copy and Download (JSON), plus `payloadHash` / `argsHash` of the stored original for off-host verification. `cb_auth_token`, resume handles, and secret-like fields are stripped on the read and again in the UI. `editedArgs` stay in their own labelled section and are never shown as the request. Session-authenticated reviewer access only, identical to the approval detail.
