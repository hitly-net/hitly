# SSO (Google, GitHub, Microsoft)

Status: **draft design note**. Docs only. No implementation, migration, or deploy.

This note proposes social SSO for HITLy via Better Auth social providers (Google, GitHub, Microsoft). SAML / enterprise OIDC is a later Cloud feature, sketched at the end.

It is not part of the public docs site (`apps/web/content/docs`). Keep it out of that navigation.

SSO is a **Cloud** entitlement (`FEATURES` includes `'sso'`; OSS `entitlementsForPlan` leaves it `false`). Provider config and buttons already sit behind the `@hitly/cloud` stub. Do not put proprietary IdP logic in this public repo; fill the private overlay. Account-linking, MFA, and workspace-enforcement **rules** in this note still apply wherever SSO is turned on.

---

## Current auth (main)

Read from the code. Anything not listed here is not on main.

| Area | What exists |
| --- | --- |
| Library | Better Auth range in `apps/app/package.json` is `^1.3.8`; **the lockfile installs `1.6.27`** (`yarn.lock` / `node_modules/better-auth`). Linking and social-provider behaviour below is from that installed tree, not from 1.3.x docs. Instance in `apps/app/lib/auth.ts`. Catch-all `app/api/auth/[...all]/route.ts`. |
| Public URL | `BETTER_AUTH_URL` (fallback `http://localhost:3001`). Callbacks, invite links, reset and email-change links all derive from this. |
| Email + password | Enabled. Min length 8. Sign-up `POST /api/auth/sign-up/email`, sign-in `POST /api/auth/sign-in/email`. Reset: `revokeSessionsOnPasswordReset: true`. Signed-in change: `POST /api/session/change-password` with `revokeOtherSessions: true`, then a notice email. |
| Email verification | `users.email_verified` exists (default `false`). **Better Auth `emailVerification` is not configured.** Public sign-up does not send a verification mail and does not set the flag. `/verify-email` is a static “check your inbox” page. The flag is set `true` after **new-account invite accept** (`acceptInviteWithNewAccount` — the token arrived in that inbox) or **confirmed email change**. **`acceptInviteAsUser` does not set `emailVerified`:** a signed-in existing user who accepts an invite keeps whatever flag they already had (typically `false` after public signup). That matters for linking: they stay “unverified local” even after joining a workspace. |
| Email change | Signed-in, current password required. Live `users.email` is unchanged until the new inbox confirms a hashed one-time token (24h). Then `emailVerified` is set true and a notice goes to the **previous** address. |
| MFA | HITLy-owned TOTP + recovery codes ([#124](https://github.com/hitly-net/hitly/pull/124), [#126](https://github.com/hitly-net/hitly/pull/126)). Tables `user_mfa`, `user_mfa_recovery_codes`, `user_mfa_challenges`. Enrol / disable / regenerate re-auth with **current password** (`verifyPassword`). Confirm enrol calls `revokeOtherSessions`. Login MFA is **only** wired on email/password sign-in (`holdPasswordSignInIfMfa` matches `POST …/sign-in/email`). |
| Passkeys | **Not on main.** No passkey table, plugin, or UI. No open passkey PR in this repo at the time of writing. Treat as **planned** (a separate PR may land in parallel). Better Auth has a passkey plugin; HITLy would own enrolment and the MFA challenge the same way it owns TOTP. |
| Social SSO | Stub only. `socialProviders` from `@hitly/cloud/auth/providers` is `{}`. `SocialAuthButtons` renders nothing. Login and signup already mount the component. |
| RBAC | Workspace roles `owner` / `admin` / `member` (`isWorkspaceAdmin` = owner or admin). Project roles `admin` / `user` / `reader` in `apps/app/lib/rbac.ts`. Users can belong to several workspaces (`memberships`). |
| Invites | Tokenised, hashed, 14 days, email-bound. Signup disabled (`HITLY_SIGNUP_ENABLED=0`) still allows invite-gated account create. New-account accept (`acceptInviteWithNewAccount`) sets `emailVerified`. Signed-in accept (`acceptInviteAsUser`) does not. Bootstrap no longer auto-joins by email match. |
| Machine credentials | Project API keys (`project_api_keys`, prefix `hitly_`). MCP uses the same keys as Bearer. Origin resume tokens are separate. Better Auth `bearer()` is for **human** mobile sessions, not those keys. |
| Audit | Account-security events today: MFA enrol / disable / recovery / lockout / other-sessions-revoked (`account_security_events`). Project `project_events` is the work-item trail, not account linking. |
| Sessions | `sessions` table. Password change, password reset, and MFA confirm revoke other sessions. |

Better Auth already maps `account` → `accounts` (provider credentials and the credential-account password hash), `user` → `users`, `session` → `sessions`, `verification` → `verifications`.

---

## Goals

1. Let a person sign in with Google, GitHub, or Microsoft without sharing a HITLy password, without opening an account-takeover path through unverified emails.
2. Keep HITLy MFA (TOTP / planned passkeys / recovery codes) in front of a human session when the account has enrolled it, unless a workspace policy explicitly trusts the IdP.
3. Let a workspace admin require SSO (optionally per provider and email domain) without breaking API keys, MCP, or members of other workspaces.
4. Leave a door for enterprise SAML / OIDC later. Do not build it in the first cut.

Non-goals for the first cut: SCIM, IdP-initiated SAML, reading IdP MFA from social tokens, self-hosted custom OIDC (that is the SAML/enterprise track).

---

## 1. Account linking

An SSO identity is a row in `accounts`: `provider_id` (`google` / `github` / `microsoft`) + `account_id` (the IdP subject: Google `sub`, GitHub numeric id, Microsoft `oid` within `tid`). It points at `users.id`. Email is **not** the join key.

### 1.0 What Better Auth 1.6.27 actually does

Installed `handleOAuthUserInfo` (`better-auth/dist/oauth2/link-account.mjs`) implicit-links an existing same-email user unless **any** of these is true:

- the provider is **not** in `trustedProviders` **and** the IdP userinfo has `emailVerified === false`
- `requireLocalEmailVerified` (default **`true`**) and the local `users.email_verified` is false
- `accountLinking.enabled === false`
- `accountLinking.disableImplicitLinking === true` (default **`false`**)

Consequences for HITLy:

1. **The pre-hijack path is already blocked.** An attacker who public-signups `victim@example.com` (unverified) does **not** receive the victim’s Google/GitHub/Microsoft row on first SSO: `requireLocalEmailVerified` defaults to true, so implicit linking refuses (`"account not linked"`). Do not describe that path as an open Better Auth hole. (`requireLocalEmailVerified` is documented as deprecated; the gate is planned to become unconditional.)
2. **Empty `trustedProviders` does not stop implicit linking.** `getTrustedProviders` returns `[]` when unset. Trust only skips the IdP-`emailVerified` check. If Better Auth marks the IdP email **verified**, implicit linking still runs against a **verified** local account.
3. **That is the real takeover.** Stock Microsoft `getUserInfo` sets `emailVerified` from `email_verified` or from `verified_primary_email` / `verified_secondary_email` containing `email`. It does **not** read `xms_edov`. Combined with (2), a multi-tenant Microsoft token that Better Auth treats as verified **will auto-link onto a verified local HITLy user** (for example someone who accepted a new-account invite). Empty `trustedProviders` does not prevent that.
4. **`accountLinking.enabled: true` with no `trustedProviders` is not “explicit linking only”.** It leaves implicit linking **on**.

HITLy’s intended policy is **no silent auto-link**. In 1.6.27 that flag is:

```ts
account: {
  accountLinking: {
    enabled: true,
    disableImplicitLinking: true, // required from rollout step 1
    allowDifferentEmails: false,  // set explicitly; do not rely on the default
    allowUnlinkingAll: false,     // set explicitly; last-method unlink stays refused
    trustedProviders: [],
  },
}
```

`disableImplicitLinking: true` is the option that forces `linkSocial()` / `/link-social` from a signed-in session. Ship it in step 1; do not wait for a later “tighten linking” pass.

`linkSocial` (`/link-social` and the OAuth callback `link` branch) still checks IdP `emailVerified` unless the provider is trusted, and refuses a different email unless `allowDifferentEmails === true`. **Set `allowDifferentEmails: false` explicitly** so a future default flip cannot open cross-email links. HITLy should not pass `true` except under a documented PM exception.

### 1.1 Provider email is only evidence when the IdP asserts it

Stock `getUserInfo` is not enough for GitHub or Microsoft. **Override both** via the provider `getUserInfo` hook (Better Auth calls `options.getUserInfo(token)` first). Google’s stock ID-token `email_verified` is acceptable; still apply `hd` for workspace domain rules (§1.1.1).

| Provider | Treat as verified email only when | Stock 1.6.27 `getUserInfo` | HITLy override |
| --- | --- | --- | --- |
| **Google** | ID token `email_verified === true`, email present. | Reads `email_verified` from the ID token. Enforces optional `hd`. | Keep stock, plus `hd` for Workspace domain policy. |
| **GitHub** | Emails API entry with **`primary && verified`**. Ignore `/user` profile email (`noreply`, public unverified, non-primary). | Default scopes include `user:email` and it **does** fetch `/user/emails`, but if `profile.email` is set it uses that, else **primary or the first** address, then looks up `verified` for that choice. An unverified primary/first still becomes the email with `emailVerified: false`. | Override: only the primary+verified emails-API row; otherwise no email / `emailVerified: false`. |
| **Microsoft** | **Do not trust `email`, `preferred_username`, or `upn` in the multi-tenant case.** See below. | `emailVerified` from `email_verified` **or** `verified_*_email` includes `email`. **Does not read `xms_edov`.** Account id is ID-token `sub`. | Override: verified only with `xms_edov` (and listed domain) or single-tenant `tid`; identify by `tid`+`oid`. |

**Microsoft multi-tenant spoofing.** An app registered for any Entra ID tenant (`tenant=common` or `organizations`) will accept tokens from a tenant the operator does not control. That tenant’s admin can mint a user whose `email` / UPN **looks like** `alex@example.com` without owning the mailbox. Microsoft does not guarantee those claims are mailbox-verified for every token.

`xms_edov` (email domain owner verified) is the documented signal that the issuing tenant verified the domain. It is an **optional claim**. It is emitted only when the Entra app registration is configured to request it, and the **`email` claim must also be configured** as an optional/token claim so there is an address to bind. Stock Better Auth still will not honour `xms_edov` until HITLy’s `getUserInfo` override reads it. `email_verified` and `verified_primary_email` / `verified_secondary_email` are likewise optional claims; stock uses those and that is not sufficient.

HITLy should:

- Identify the Microsoft account by `tid` + `oid`, never by email.
- Treat email/UPN as **unverified** unless (a) `xms_edov` is true **and** the domain is one the workspace listed, or (b) the app is **single-tenant** (`AUTH_MICROSOFT_TENANT_ID` = that tenant) and we only accept that `tid`.
- **Never** put `microsoft` in `accountLinking.trustedProviders`.
- Keep `disableImplicitLinking: true` even after the override, so a Microsoft token cannot silently attach to a verified local account. Explicit `linkSocial` from a signed-in session is the Microsoft path.

### 1.1.1 Google `hd` (hosted domain)

Google Workspace ID tokens carry `hd` when the account is a Workspace user (consumer `@gmail.com` has **no** `hd`). Better Auth 1.6.27 already:

- sends `hd` on the authorize URL when `socialProviders.google.hd` is set
- rejects the ID token / profile when `hd` is missing or does not match (`isGoogleHostedDomainAllowed`; `hd: "*"` means “any Workspace domain”)

Use that for **host-level** restriction (optional `AUTH_GOOGLE_HD`, placeholder e.g. `example.com` or `*`). For **workspace** `allowedEmailDomains` (§3.1), prefer the Google `hd` claim over the email string when the session used Google: `hd` is the Workspace domain Google asserts, not a spoofable local-part. Consumer Google accounts have no `hd` — they match `allowedEmailDomains` only if the listed domain is the email domain **and** `email_verified` is true (they will not satisfy a Workspace-only list). Do not treat missing `hd` as “any domain allowed” when the workspace listed domains.

### 1.2 Unverified local accounts (already refused; recover explicitly)

A local user with `users.email_verified = false` must not gain a Google/GitHub/Microsoft row because a social token presented the same address. **Better Auth 1.6.27 already refuses that implicit link** (`requireLocalEmailVerified` default true). HITLy still sets `disableImplicitLinking: true` so verified locals are not silently linked either.

When implicit (or disabled) linking refuses, 1.6.27 does **not** create a second user and does **not** sign in as the occupying row. The SSO callback fails (`account not linked`). The occupier’s password account remains.

**Recovery when an unverified local already occupies the email** (typical after public signup, or after `acceptInviteAsUser` which does not flip `emailVerified`):

| Who controls the mailbox? | What to do |
| --- | --- |
| The occupier does (they signed up with that address, or it is theirs) | Sign in with **password**. Request a **password reset** if they forgot it (the reset mail already goes to that address; HITLy does not say whether the account exists). Then **explicit-link** SSO from Security. Optionally complete email verification if/when that flow is wired. Do not create a second HITLy user. |
| A third party registered the address and never verified | The mailbox owner uses the **same password-reset path**. Reset proves inbox control and lets them take over the occupying password account, then explicit-link SSO. Do **not** send a “verify email to free this address” link that would set `emailVerified` on the occupier and then auto-link the owner’s IdP into that row — that is the old hijack, and `disableImplicitLinking` is what keeps even a later verification from attaching the IdP silently. |
| Occupier has no password (should not happen for unverified locals today: only email+password signup leaves `emailVerified` false) | Refuse SSO with the generic error. Do not JIT-create a second user for the same email (`users.email` is unique). Host admin / Cloud support recovery is overlay-only; not a public backdoor. |

SSO error copy stays generic (no “an account exists for this email”), matching invite and email-change enumeration policy. Audit `sso_link_refused`.

`acceptInviteAsUser` leaving `emailVerified` false means a public-signup member can sit in a workspace and still be blocked from implicit SSO until they reset/verify/explicit-link. That is intended. New-account invite (`acceptInviteWithNewAccount`) is already verified and would be auto-linked **unless** `disableImplicitLinking: true`.

### 1.3 Explicit linking is the safe default

**Default (step 1):** `disableImplicitLinking: true`. The person is already signed in (password, invite, or an existing SSO method), opens Settings → Security, chooses “Link Google / GitHub / Microsoft”, completes OAuth (`linkSocial` / `/link-social`), and HITLy inserts the `accounts` row. Microsoft stays on this path.

Optional later **trusted-provider auto-link** (off unless PM turns it on): set `disableImplicitLinking: false` **only** together with a `getUserInfo` that HITLy trusts, and only for Google (and maybe GitHub). Still never Microsoft. Still never unverified local (`requireLocalEmailVerified` remains true). Empty `trustedProviders` is **not** a substitute for `disableImplicitLinking`.

First-time SSO with **no** HITLy user: create via the existing `databaseHooks.user.create` path (`gateAccountCreation` + `bootstrapUserWorkspaces`). If public signup is off, SSO create is invite-only, same as password create. Set `emailVerified` true only when the provider assertion passed §1.1. If a user **does** exist for that email, do not create; follow §1.2.

### 1.4 Local email changes later

Signed-in email change (already shipped) updates `users.email` after the new inbox confirms, notifies the old address, and sets `emailVerified` true. It does **not** rewrite `accounts`.

After a change:

- Linked SSO still authenticates by `provider_id` + `account_id`. It must not break.
- Do not silently unlink because the IdP email no longer matches `users.email`.
- Do not silently attach a *different* IdP user whose email equals the new address.
- If a workspace lists allowed domains, a change off-domain is a **workspace access** problem (see §3), not an unlink.
- Store a snapshot of the provider email at link time for the Security UI (“Google · alex@example.com”); the snapshot is display only.

If the new address is already a different HITLy user, today’s change flow refuses. SSO does not change that.

### 1.5 Unlinking

- A user may unlink a provider from a signed-in session after re-auth (password if one exists; otherwise a fresh SSO round-trip or planned passkey).
- **Cannot unlink the last sign-in method.** Better Auth 1.6.27 already refuses this when `allowUnlinkingAll` is not true (`FAILED_TO_UNLINK_LAST_ACCOUNT`). Set `allowUnlinkingAll: false` explicitly. If the only remaining methods are one social account and no credential password (no `accounts` row with `provider_id = 'credential'` / no password hash), refuse. Same if they have a password but it is the last method and they try to delete it — out of scope here, but the same invariant: at least one way to sign in must remain.
- Unlink does not delete the `users` row or workspace memberships.

### 1.6 Notices, audit, sessions

On **link** and **unlink** (success only):

- Email the current `users.email`. Copy style matches password-changed / email-changed: no token, no secret, no provider tokens. Say which provider was linked or unlinked.
- Insert `account_security_events` (`sso_linked`, `sso_unlinked`, and `sso_other_sessions_revoked` when sessions are dropped). Log lines stay value-free: event name + `user=<id>` + provider id, never tokens.
- **Revoke other sessions** (`auth.api.revokeOtherSessions`), current device kept — same as password change and MFA confirm (#126). A newly linked IdP must not leave older sessions that were minted before the link sitting around.

Failed link attempts (unverified email, last-method unlink, collision) audit as `sso_link_refused` without saying whether the email is taken, to match invite and email-change enumeration policy.

---

## 2. SSO and MFA

HITLy MFA is **account-level**, not workspace-level, and is not Better Auth’s two-factor plugin. Social callbacks today would mint a full session: `holdPasswordSignInIfMfa` only wraps email/password sign-in. SSO must use the same hold pattern (stash Set-Cookie, issue `hitly.mfa_challenge`, finish on `/login/mfa`).

### 2.1 Recommendation

**If the user has HITLy MFA enrolled (`user_mfa.enabled`), every new human session — password or SSO — still needs TOTP, a recovery code, or a planned passkey.** Social providers are not a second factor.

Exception (workspace policy, Cloud): the workspace **requires SSO** **and** an admin has set “trust IdP MFA”. Then skip HITLy MFA for sessions that used that workspace’s allowed provider. **Do not** infer this from token `amr` / `acr` on Google, GitHub, or Microsoft consumer/multi-tenant social login — those claims are absent, optional, or not comparable across IdPs. Trust is an explicit HITLy switch, default off.

SSO-only users (no password) cannot use today’s enrol / disable / email-change paths, which all call `verifyPassword`. First implementation must add a re-auth path: fresh SSO round-trip (or planned passkey) in place of the password. Until that exists, do not ship SSO-only accounts into MFA enrolment.

### 2.2 Recovery codes

Unchanged: HITLy-issued, HMAC stored, shown once, consume on use. They are not the IdP’s backup codes. Using one still completes the HITLy MFA challenge after SSO.

### 2.3 Passkeys (planned)

A separate PR may add WebAuthn. Relative to SSO:

- **Second factor:** a passkey can satisfy the MFA challenge after password or SSO, same slot as TOTP.
- **Primary:** a discoverable passkey can sign in without SSO or password; if HITLy MFA is also enrolled, still require a *different* factor (TOTP or a second passkey), unless product explicitly allows a single passkey as both.
- Unlink / last-method rules count a passkey as a sign-in method.
- Do not block this SSO design on passkeys landing; wire the MFA hold so a passkey step can plug into the same challenge cookie.

---

## 3. Workspace-level “require SSO”

Auth is **user-level**. Policy is **workspace-level**. A person can be `owner` of workspace A (password allowed) and `member` of workspace B (SSO required). Login cannot be a single global switch.

### 3.1 Setting

Workspace admins (`owner` / `admin`, `canManageWorkspace`) get a Cloud-only setting, gated by `hasFeature(entitlements, 'sso')`:

- `requireSso: boolean` (default false)
- Optional `allowedProviders: ('google' | 'github' | 'microsoft')[]` (empty = any enabled host provider)
- Optional `allowedEmailDomains: string[]` (empty = no domain extra). Match the normalised email of the **HITLy user** after sign-in. For Google sessions, prefer the ID-token **`hd` claim** when present (§1.1.1). For Microsoft, prefer verified-domain / `xms_edov` as in §1.1 — not a spoofable `email` / UPN.

OSS: setting hidden, `sso` feature false. Host-wide provider client IDs stay env (below), not per workspace, for this social cut. Per-workspace IdP is the SAML track.

### 3.2 Effect on existing password users

Requiring SSO does not delete passwords or `accounts` credential rows.

Recommended behaviour:

1. Members can still **sign in** with password (account-level).
2. **Entering** a require-SSO workspace (switcher, deep link, default workspace) needs a session that has completed an allowed provider this session (store a session flag or a short-lived “SSO proven” marker). If not, prompt that provider; on success, continue.
3. Admin UX: warn before enabling (“members will need to link {providers}”). Optional grace: password-only members keep access for a configurable window; after that, workspace APIs and pages return a dedicated “SSO required” error, not a generic 403.

Immediate lockout of password-only members without a link path is not the default.

### 3.3 Break-glass

IdP outages must not wipe the last workspace owner.

- At least one **workspace owner** (or a designated break-glass admin) may use a HITLy password to reach **that** workspace even when require-SSO is on. Record `sso_break_glass` in `account_security_events` and email the owner.
- Cloud operations break-glass (impersonation / support) stays a private overlay concern; do not document a public backdoor.
- Self-host with Cloud overlay off: require-SSO is off, so this does not apply.

Break-glass must not disable HITLy MFA if enrolled.

### 3.4 Invitations

Invites stay email-bound tokens. When the workspace requires SSO:

- The accept page tells the invitee to continue with the allowed provider(s).
- Completing accept (new account or existing) requires a provider assertion whose **verified** email matches the invite email (`normaliseEmail`). Microsoft: explicit link or verified-domain rules in §1.1; do not accept a spoofable UPN as the invite match.
- Existing-user accept still uses `acceptInviteAsUser` and still does **not** set `emailVerified`. Require-SSO workspaces should send the invitee through SSO first (so the new or linked account is verified) rather than password-login then accept.
- Do not let invite-accept create a password-only user into a require-SSO workspace unless they are the break-glass owner path (they are not).
- Pending invites already sent remain valid; the accept UI changes, not the token.

### 3.5 API keys and MCP tokens

**Unaffected.** Project API keys and MCP `Authorization: Bearer hitly_…` are requester credentials for ingest / `request_approval` / `get_decision`. They are not human SSO. Origin resume tokens likewise. Do not gate them on workspace SSO policy.

Mobile human sessions (Better Auth `bearer()` + `x-hitly-workspace-id`) **are** human sessions: require-SSO applies when that session selects a restricted workspace.

### 3.6 Several workspaces, different policies

| Session | Workspace A (password OK) | Workspace B (require Google) |
| --- | --- | --- |
| Signed in with password only | Allowed | Challenge Google; then enter B |
| Signed in with Google (and MFA if enrolled) | Allowed | Allowed |
| Signed in with GitHub only | Allowed | Challenge Google (if Google is the only allowed provider) |

Do not sign the user out of A because B requires SSO. Do not force every workspace onto the strictest member policy. Evaluate on **workspace access**, not at the login form.

---

## 4. SAML later (enterprise)

Out of the first social cut. Sketch only:

- Better Auth **SSO plugin** (SAML and/or OIDC enterprise connections), not the Google/GitHub/Microsoft social providers.
- **Domain verification** before a workspace may capture `example.com` (DNS TXT or equivalent). JIT provisioning of users on first successful assertion, still respecting invite-only hosts (`HITLY_SIGNUP_ENABLED`).
- **SCIM** later (provision / deprovision memberships). Not required to ship SAML.
- **Per-workspace IdP** config (ACS URL, entity ID, client id/secret, metadata) lives in the private Cloud overlay. ACS / redirect URLs still derive from `BETTER_AUTH_URL`.
- **Pricing:** keep `sso` on `Entitlements.features`. Likely split: social SSO on a paid Cloud plan; SAML/OIDC + SCIM on `enterprise`. Exact mapping is a PM question. OSS stays `sso: false`.

Social linking rules (`disableImplicitLinking: true`, HITLy `getUserInfo`, last-method unlink, MFA) apply to enterprise connections unless a workspace explicitly trusts that IdP for MFA.

---

## Env vars and callback URLs

Host-level. Names only; values are placeholders. Never commit real client secrets.

Already required by the app:

- `BETTER_AUTH_URL` — public base URL of `apps/app` (no trailing-path surprises: CORS already uses `new URL().origin`).
- `BETTER_AUTH_SECRET` — existing signing secret.

New (Cloud overlay; empty/unset = that provider off):

| Variable | Purpose |
| --- | --- |
| `AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET` | Google OAuth client |
| `AUTH_GOOGLE_HD` | Optional. Passed to Better Auth `socialProviders.google.hd` (placeholder `example.com`, or `*` for any Google Workspace domain). Unset = no host-level `hd` restriction. |
| `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` | GitHub OAuth app (`user:email`) |
| `AUTH_MICROSOFT_CLIENT_ID` / `AUTH_MICROSOFT_CLIENT_SECRET` | Entra ID app |
| `AUTH_MICROSOFT_TENANT_ID` | Placeholder `common` (multi-tenant, spoofing risk) or a tenant GUID (single-tenant). Prefer a GUID in production. |

Better Auth’s default base path is `/api/auth`. Register these redirect URIs on each IdP, derived only from `BETTER_AUTH_URL`:

```text
{BETTER_AUTH_URL}/api/auth/callback/google
{BETTER_AUTH_URL}/api/auth/callback/github
{BETTER_AUTH_URL}/api/auth/callback/microsoft
```

Example if `BETTER_AUTH_URL=https://app.example.com`: `https://app.example.com/api/auth/callback/google` (and github, microsoft).

No extra public env is needed for require-SSO; that is workspace data. Mobile associated-domain setup is unchanged (`HITLY_MOBILE_APP_ID` etc.).

---

## Data model

**`accounts` already exists** (Better Auth drizzle adapter). Columns: `user_id`, `account_id`, `provider_id`, tokens, `password` (credential provider), timestamps. Indexed on `user_id` only today.

Additive changes (implement later, not in this PR):

1. **Unique (`provider_id`, `account_id`)** on `accounts` so one IdP subject cannot attach to two HITLy users. Confirm Better Auth’s expected constraint name before writing the migration.
2. **`account_security_events.type`** values for SSO (string column already; no enum migration required): `sso_linked`, `sso_unlinked`, `sso_link_refused`, `sso_other_sessions_revoked`, `sso_break_glass`.
3. **Workspace SSO policy** — prefer a **Cloud overlay table** (not public `workspaces` columns, unlike the leftover Stripe fields). Shape: `workspace_id`, `require_sso`, `allowed_providers`, `allowed_email_domains`, `trust_idp_mfa`, `break_glass_user_id` (nullable). OSS never reads it.
4. Optional: `accounts.provider_email` snapshot (display). Not an auth key.
5. Session metadata for “SSO provider proven this session” — Better Auth session extra fields or a small side table. Needed for §3.2.

No change to `project_api_keys`, MCP, or plugin packages.

Passkeys, when they land, get their own tables (Better Auth passkey plugin). Do not overload `accounts` for WebAuthn.

---

## Rollout

Docs-only until this note is accepted. Then, in order:

1. **Cloud overlay:** fill `socialProviders` and `SocialAuthButtons` from env. **Required linking config (do not ship without this):** `accountLinking.disableImplicitLinking: true`, `allowDifferentEmails: false`, `allowUnlinkingAll: false`, `trustedProviders: []`. `accountLinking.enabled: true` with an empty `trustedProviders` list **must not** be treated as “no auto-link” — that combination still implicit-links when the IdP userinfo is `emailVerified` (stock Microsoft would take over a verified local account). Override GitHub and Microsoft `getUserInfo` as in §1.1. Explicit `linkSocial` UI on Security. Unique index on `accounts`.
2. **MFA hold** on OAuth callback / token exchange, same challenge cookie as password. Re-auth via SSO for enrol/email-change when the user has no password.
3. Notices + `account_security_events` + `revokeOtherSessions` on link/unlink.
4. Workspace require-SSO + domain list (`hd` / `xms_edov`) + break-glass, gated by `sso`. Invite accept respects it.
5. Optional Google/GitHub implicit auto-link only if PM turns it on: then `disableImplicitLinking: false` **and** HITLy-trusted `getUserInfo`. Still never Microsoft. Still never unverified local.
6. SAML / OIDC enterprise + domain verification; SCIM later.

Host flags: providers appear only when their client id/secret pair is set. Missing Microsoft tenant → do not enable Microsoft. Feature flag `sso` still hides admin UI on OSS and on Cloud plans that do not include it.

---

## Test plan

No new tests in this PR. Implementation PRs should cover:

**Linking / takeover**

- With `disableImplicitLinking: true`, Google verified + local verified + matching email still does **not** auto-link; Security `linkSocial` succeeds.
- Google verified + local `emailVerified=false`: implicit link refused even if `disableImplicitLinking` were false (`requireLocalEmailVerified`). Occupying unverified account: SSO does not create a second user; password reset + explicit link recovers (§1.2).
- `acceptInviteAsUser` does not set `emailVerified`; that member still cannot be implicit-linked until verified / explicit-link.
- GitHub: stock profile/first-email path is overridden; public and unverified-primary ignored; primary+verified matches.
- Microsoft stock `emailVerified` (from `email_verified` / `verified_*_email`, **not** `xms_edov`) plus empty `trustedProviders` would implicit-link a verified local if `disableImplicitLinking` is left false — that regression test must fail closed. With HITLy config, a multi-tenant `email=victim@example.com` token cannot auto-link; explicit link from victim’s session still binds `tid`+`oid`.
- Two HITLy users cannot receive the same `(provider_id, account_id)` (unique constraint).
- Last sign-in method cannot be unlinked (`allowUnlinkingAll: false`).
- Email change leaves SSO login working; new address does not steal another user’s Google.
- `linkSocial` with a different IdP email is refused (`allowDifferentEmails: false`).

**MFA**

- Enrolled TOTP: SSO callback does not set a session cookie; `/login/mfa` then TOTP or recovery code does.
- Not enrolled: SSO session is issued (signup/invite policy permitting).
- Recovery code consumed once; lockout counters shared with password MFA.
- `trust_idp_mfa` off: SSO still challenges HITLy MFA. On: only for that workspace’s allowed provider, and not based on `amr`.

**Workspace policy**

- Password login, then open require-SSO workspace → provider challenge; other workspace still loads.
- Invite to require-SSO workspace: password-only accept refused; matching verified SSO accept joins.
- API key ingest and MCP initialize with `hitly_…` succeed while require-SSO is on.
- Break-glass owner password access audited.

**Regression**

- Existing email/password, reset, email-change, MFA enrol/disable, invites, and `HITLY_SIGNUP_ENABLED=0` unchanged when SSO env is unset (stub buttons still empty).

---

## Open questions for PM

1. **Auto-link.** Step 1 ships `disableImplicitLinking: true`. Later, allow Google/GitHub implicit link on dual-verified email, or keep explicit-only? Microsoft stays explicit.
2. **Plans.** Which Cloud plans get social SSO vs SAML? Is `sso` one flag or two (`sso_social`, `sso_saml`)?
3. **Microsoft.** Support `common` (any Entra tenant) at all, or only single-tenant / verified-domain customers?
4. **Grace period** when turning on require-SSO: days, until each member links, or next login?
5. **Break-glass.** Any owner, a named user, or Cloud support only? Should break-glass skip HITLy MFA (recommendation: no)?
6. **SSO-only MFA.** Require HITLy TOTP for SSO users, offer it, or wait for passkeys?
7. **Passkeys vs SSO.** Primary sign-in, second factor, or both? Does require-SSO accept a passkey in place of the IdP?
8. **JIT vs invite-only.** On Cloud with signup off, is first Google login enough when the email domain is verified, or is an invite always required?
9. **Mobile.** First-cut SSO on web only (today’s `SocialAuthButtons` on login/signup), or same providers in Expo via Better Auth?
10. **Unverified legacy users.** Force email verification before any `linkSocial` UI, or let them explicit-link after password re-auth only? Password-reset takeover of an occupying unverified account is specified in §1.2 — confirm that is acceptable product-wise.

---

## Implementation notes (when coding starts)

- Public repo seams only: `apps/app/lib/auth.ts` (`socialProviders`), login/signup buttons, MFA hold around the auth route, Security page, `account_security_events`. Provider secrets, `getUserInfo` overrides, and require-SSO admin UI: private `@hitly/cloud`.
- Pin behaviour to installed Better Auth **1.6.27** (range `^1.3.8`). Re-read `dist/oauth2/link-account.mjs` and social-provider `getUserInfo` if the lockfile moves.
- Do not put this in `packages/plugin-http` or `apps/mcp`.
- Do not log tokens, codes, or client secrets (see `lib/auth-logging.ts`).
- Extend, do not replace, `holdPasswordSignInIfMfa` so password MFA stays the reference behaviour.
