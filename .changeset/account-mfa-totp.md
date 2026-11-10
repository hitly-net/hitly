---
"@hitly/app": patch
---

Authenticator-app MFA (TOTP) with one-time recovery codes. Enrolment generates an encrypted secret and hashed recovery codes, then activates only after a valid TOTP. Login for MFA-enabled accounts holds the Better Auth session until a TOTP or recovery code is presented. Enable, disable, and recovery-code regenerate reuse the signed-in current-password check. Additive migration 0008_account_mfa.
