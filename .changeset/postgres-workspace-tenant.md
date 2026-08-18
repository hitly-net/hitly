---
"@hitly/db": minor
"@hitly/core": minor
"@hitly/app": minor
---

Switch the server schema to Postgres and stamp `workspace_id` on every tenant row so Cloud can add RLS without leaking envelopes.
