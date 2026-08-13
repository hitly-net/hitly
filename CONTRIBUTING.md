# Contributing

## Setup

```bash
yarn install
cp apps/app/.env.example apps/app/.env.local
yarn db:up
yarn db:migrate
yarn dev:web   # http://localhost:3000
yarn dev:app   # http://localhost:3001
```

## Layout

- `apps/web` — marketing and docs
- `apps/app` — Next.js server (self-hosted and Cloud share this app)
- `packages/core` — envelope types and edition/entitlements contract
- `packages/cloud` — OSS stub for Cloud slots (billing routes, billing UI)
- `packages/plugin-*` — origin-framework adapters

Cloud-only implementations do not belong in this repository. Keep Stripe, metering, and SSO behind `@hitly/cloud` exports so the private overlay can replace the stub.

## Checks

```bash
yarn lint
yarn typecheck
yarn build
```

Use Yarn, not npm. Open a pull request against `main`.

CI is defined in `.github/ci.yml`. After granting the GitHub `workflow` scope (`gh auth refresh -s workflow`), move it to `.github/workflows/ci.yml` so Actions can run.
