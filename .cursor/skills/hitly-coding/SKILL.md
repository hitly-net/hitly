---
name: hitly-coding
description: Hitly monorepo coding conventions, package roles, and OSS vs Cloud edition split. Use whenever writing, moving, or reviewing Hitly code; adding a package, plugin, API route, or UI; touching entitlements, Stripe, billing, or self-host vs Cloud; or when unsure where a change belongs.
---

# Hitly coding

Yarn 1 + Turbo. Prefer `yarn` over npm. Read [packages.md](packages.md) before adding or relocating a package.

## Where code goes

- **Integrators / envelope / plugin contract** → `@hitly/core` and `@hitly/plugin-*` (`hitly.role: sdk`).
- **Inbox, auth, settings, API routes in the Next app** → `apps/app`. Keep Stripe/billing handlers as re-exports from `@hitly/cloud`.
- **Schema and migrations** → `@hitly/db`. Default workspace `plan` is `self-hosted`. Stripe columns are Cloud-only leftovers; do not build OSS features on them.
- **Marketing/docs** → `apps/web` (Fumadocs MDX under `content/`).
- **Cloud-only behavior** (Stripe, usage metering, SSO, hosted plan limits) → private `hitly-net/hitly-cloud` `@hitly/cloud`, never this public stub.

## OSS vs Cloud

Gate by **package presence**, not `HITLY_EDITION` env vars.

- Public `packages/cloud` is a stub: OSS entitlements, no billing nav, Stripe routes 404.
- `@hitly/core` owns `HitlyEdition`, `Entitlements`, `hasFeature`, `requireFeature`.
- App shell nav comes from `edition.navItems`. Billing pages and `/api/stripe/*` re-export `@hitly/cloud`.
- Adding a Cloud feature: extend the stub export map here, implement it in `hitly-cloud`.

## Conventions

- Match existing file patterns (Next App Router, Drizzle, Better Auth).
- New origin frameworks: new `@hitly/plugin-<id>`, add the id to `PLUGIN_IDS` in `@hitly/core`.
- Local DB is Postgres (`yarn db:up`, `yarn db:migrate`). Cloud overlay may enable RLS; OSS does not.
- After code changes: `yarn typecheck` (and `yarn lint` / `yarn build` if you touched apps).
- LAN production deploy (192.168.10.176): read [hitly-deployment](../hitly-deployment/SKILL.md).

## Do not

- Publish or put proprietary billing/SSO logic in this repo.
- Create a second Next.js app to “extend” the server.
- Use npm or pnpm.
- Add packages without `hitly.role`.
