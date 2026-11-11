# HITLy Cloud and the `hitly-cloud` overlay

## Status

HITLy Cloud is the private, hosted edition of HITLy. It is **not
generally available**: the public entry point is a waitlist on the website
(see [website.md](website.md)). Do not treat it as an available service, and
do not expect the code here to reveal any hosted endpoints.

## Model: an overlay, not a fork

The open-source repo ships `@hitly/cloud` as an **edition stub**
(`packages/cloud`, role `edition-stub`). The private overlay repo
(`hitly-net/hitly-cloud`) provides a same-name package with the real hosted
implementation, so the same app code runs in both editions. The edition is
gated by **which package is installed**, not by an edition environment
variable.

## What the public stub defines (`packages/cloud`)

- `src/edition.ts` - the `oss` edition object: entitlements resolved from the
  workspace plan, OSS navigation items (the app shell renders nav from
  `edition.navItems`).
- `src/auth/` - provider/button slots that a hosted build can extend with
  additional sign-in methods.
- `src/brand.tsx` - branding slot.
- `src/pages/` - billing/invoice page slots.
- `src/stripe/` - checkout, portal, subscription, invoices, webhook slots;
  `unavailable.ts` makes them inert, so in the OSS edition the billing pages
  render nothing useful and the Stripe routes 404.

`@hitly/core` owns the shared shapes: `HitlyEdition`, `Entitlements`,
`hasFeature`, `requireFeature`, and the plan tables.

## How `apps/app` consumes it

The app imports `@hitly/cloud` (transpiled workspace package) for: the
edition object (nav, entitlement checks), auth provider buttons, brand
marks, the billing pages under `/settings/billing`, and the `/api/stripe/*`
route re-exports. In the OSS edition every cloud-only path degrades to a
stub; swapping in the overlay package turns the same slots into the hosted
implementation (billing, SSO, hosted plan limits - all private).

## Data-flow position

The cloud overlay does not sit in the approval path: ingest, decision, and
resume flow exactly as in the OSS edition (see
[README.md](README.md)). Overlay behavior is account/platform-level
(billing, auth providers, branding, plan gating).

## Configuration

No environment variables belong to the public stub itself (it reads none);
its behavior is chosen by package presence. Stripe/webhook secrets would be
configuration of the private overlay and are deliberately not documented
here.

## Unconfirmed (everything below is private-repo territory)

- The overlay's implementation, its Stripe account setup, SSO providers,
  provisioning, and any hosted-only infrastructure are not in this repo and
  cannot be described from code here.
- Whether the overlay enables database row-level security is asserted in
  repo-internal agent guidance only; it is not observable in public code.
- GA timing, pricing, and the hosted signup flow (beyond the website
  waitlist) are not defined in this repo.
