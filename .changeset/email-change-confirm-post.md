---
"@hitly/app": patch
---

Email-change confirmation is POST-only. GET (and HEAD/prefetch) of /verify-email-change only renders a Confirm button; the token is consumed solely by a same-origin JSON POST to /api/session/verify-email-change, so a mail scanner cannot use up the link.
