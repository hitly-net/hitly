---
"@hitly/app": patch
---

Signed-in email change on the Security page. The signed-in user gives the current password (checked through Better Auth's existing verifyPassword helper; a wrong one is refused with the shared INVALID_PASSWORD wording and stores nothing) and a new address. The live account email is left unchanged until the new inbox confirms a one-time link (32-byte token, stored only as a SHA-256 hash, 24h expiry, a new request replaces any earlier pending row). Confirm re-checks that the address is free (case-insensitive, same normalisation as signup) then switches atomically, clears the pending row, and emails a notice to the previous address. Request replies never say whether the new address is already in use. POST /api/session/change-email and POST /api/session/verify-email-change keep the sign-out route's same-origin + JSON policy; per-client attempts are throttled with the shared limiter factory (10 per 15 minutes).
