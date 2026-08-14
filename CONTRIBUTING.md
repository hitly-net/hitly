# Contributing

## Setup

```bash
yarn install
cp apps/app/.env.example apps/app/.env.local
yarn db:up
yarn db:migrate
yarn dev:web     # http://localhost:3000
yarn dev:app     # http://localhost:3001
yarn dev:mastra  # http://localhost:4111 Mastra Studio demo
```

## Layout

- `apps/web` — marketing and docs (`hitly.role: app`)
- `apps/app` — Next.js server, self-hosted and Cloud (`hitly.role: app`)
- `packages/core` and `packages/plugin-*` — public SDKs (`hitly.role: sdk`); future npm packages
- `packages/db`, `packages/ui` — server/internal (`hitly.role: internal`); never published
- `packages/cloud` — OSS Cloud stub (`hitly.role: edition-stub`); never published
- `examples/*` — samples (`hitly.role: example`)

Cloud-only implementations do not belong in this repository. Keep Stripe, metering, and SSO behind `@hitly/cloud` exports so the private overlay can replace the stub.

Agent skills: `.cursor/skills/hitly-coding`, `.cursor/skills/hitly-release`, `.cursor/skills/hitly-deployment`. LAN production: [deploy/README.md](deploy/README.md).

## Versioning

User-facing SDK changes: `yarn changeset` on the PR. Do not publish to npm until SDK packages have a `dist/` build (see the release skill).

## Checks

```bash
yarn lint
yarn typecheck
yarn build
```

Use Yarn, not npm. Open a pull request against `main`.

CI is defined in `.github/ci.yml`. After granting the GitHub `workflow` scope (`gh auth refresh -s workflow`), move it to `.github/workflows/ci.yml` so Actions can run.
