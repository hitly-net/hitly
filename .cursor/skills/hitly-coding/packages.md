# Package map

Every workspace `package.json` has `hitly.role`. Agents use that field, not guesses.

## Roles

| Role | Packages | npm | Notes |
| --- | --- | --- | --- |
| `sdk` | `@hitly/core`, `@hitly/plugin-mastra`, `@hitly/plugin-hermes`, `@hitly/plugin-http`, `@hitly/plugin-langgraph`, `@hitly/plugin-temporal` | Yes, later | Public Apache-2.0. Keep `private: true` until first publish. |
| `app` | `@hitly/app`, `@hitly/web`, `@hitly/mobile` | Never | Next.js apps and the Expo reviewer client. |
| `internal` | `@hitly/db`, `@hitly/ui` | Never | Server schema/migrations and app UI. |
| `edition-stub` | `@hitly/cloud` | Never | Public stub. Real implementation is private `hitly-net/hitly-cloud`. |
| `example` | `@hitly/example-mastra`, `@hitly/example-hermes` | Never | Samples only. |

Root `package.json` is the Yarn/Turbo workspace. It is not an npm library.

## Directory layout

```
apps/app                 @hitly/app          self-hosted + Cloud Next.js shell
apps/web                 @hitly/web          marketing + docs
apps/mobile              @hitly/mobile       Expo reviewer app (iOS + Android)
packages/core            @hitly/core         envelope, plugin interface, entitlements
packages/plugin-*        @hitly/plugin-*     origin-framework adapters
packages/db              @hitly/db           Drizzle schema + MariaDB migrations
packages/ui              @hitly/ui           shared React primitives
packages/cloud           @hitly/cloud        OSS edition stub (slots only)
examples/mastra          @hitly/example-mastra
examples/hermes          @hitly/example-hermes
examples/n8n             HTTP recipe (n8n Wait)
examples/notion          HTTP recipe (Notion Status)
```

## New package checklist

1. Put it under `packages/<name>` (or `apps/` / `examples/` if it is not a library).
2. Name it `@hitly/<name>`.
3. Set `hitly.role` (`sdk` | `app` | `internal` | `edition-stub` | `example`).
4. SDK only: `license`, `repository.directory`, `publishConfig.access: public`. Stay `private: true` until release.
5. Export TypeScript from `src/` for the workspace. Do not add a `dist/` build until the first npm publish (see hitly-release).
6. Add the package to `.changeset/config.json` `ignore` unless `role` is `sdk`.
7. If `@hitly/app` consumes it, add it to `transpilePackages` in `apps/app/next.config.mjs`.

## Workspace vs npm

Today Next.js transpiles workspace TypeScript (`exports` point at `./src/index.ts`). npm consumers need compiled `dist/`. Do not flip `private` to `false` until that build exists.
