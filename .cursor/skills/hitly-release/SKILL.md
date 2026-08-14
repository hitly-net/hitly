---
name: hitly-release
description: Hitly npm release and versioning for @hitly SDK packages. Use when the user mentions release, publish, npm, version, changelog, changeset, tag, or cutting a SDK package; when preparing @hitly/core or @hitly/plugin-* for npm; or when asked how packages are versioned.
---

# Hitly release

Only packages with `"hitly": { "role": "sdk" }` are npm candidates. Everything else stays private. See [packages.md](packages.md).

Current SDK set: `@hitly/core`, `@hitly/plugin-mastra`, `@hitly/plugin-n8n`, `@hitly/plugin-langgraph`, `@hitly/plugin-temporal`.

## Versioning (now)

User-facing SDK changes get a changeset. Apps and internal packages do not.

```bash
yarn changeset          # prompt: which SDK packages, patch/minor/major
yarn version-packages   # applies .changeset/*.md → package.json + CHANGELOG
```

Independent versions. `updateInternalDependencies: patch` in `.changeset/config.json`. Ignored packages must stay in that `ignore` list.

Commit the changeset file on the PR that contains the change. Run `version-packages` on release, not on every feature PR.

## First npm publish (not yet)

Do not `changeset publish` or `npm publish` until all of this is true:

1. Each SDK package has a `build` that emits `dist/` (JS + `.d.ts`).
2. `exports` point at `dist/`, not `src/`. Workspace/Next may still transpile source during that migration.
3. `"private": true` is removed on SDK packages only (keep it on apps/internal/stub/examples).
4. npm org `hitly` exists and CI has an `NPM_TOKEN`.
5. `yarn typecheck` and `yarn build` pass on `main`.

Until then, Changesets still records intent; versions stay `0.0.1`.

## What never publishes

- `@hitly/app`, `@hitly/web` — applications
- `@hitly/db`, `@hitly/ui` — server/internal
- `@hitly/cloud` — edition stub; the real module is git-only in `hitly-net/hitly-cloud`
- `@hitly/example-*`

Do not publish from the Cloud overlay repo. That repo overlays the app; it is not the npm source.

## Release PR shape

1. Confirm which SDK packages changed (`git diff` + existing `.changeset/` files).
2. Add a changeset if the PR is missing one and the change is user-facing.
3. On the release PR: `yarn version-packages`, review CHANGELOGs, tag after merge (when publish is enabled).

Changelog language: user-facing, present tense, like the rest of the repo (“Add Mastra resume helper”), not “I added…”.
