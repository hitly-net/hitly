# Mobile app (`apps/mobile`)

## Purpose

The Expo (React Native) reviewer client for iOS and Android. It mirrors the
web inbox on a phone: sign in to a HITLy host instance, browse the pending
queue, open a decision-needed push, and decide. Reviewers can point the app
at different host instances (self-hosted or hosted), with a mismatch sheet
that surfaces which instance a piece of data came from.

## Where it lives

- `apps/mobile/app/` - Expo Router screens: `(auth)` sign-in flow, `inbox`,
  `projects`, `workspace`, `settings`, tabs layout.
- `apps/mobile/src/api/hitly-client.ts` - the typed REST client
  (inbox summary, approval detail, decide, projects, workspaces, push-token
  register/deregister).
- `apps/mobile/src/api/headers.ts` - auth/workspace/client headers.
- `apps/mobile/src/config.ts` - base-URL normalization, same-origin helpers,
  the deep-link scheme, and the built-in default hosted instance constant.
- `apps/mobile/src/providers/` - `SessionProvider`, `NativePushProvider`
  (Expo push registration), `NotificationProvider`, `AttentionProvider`,
  `LinkNotificationProvider`, `MenuProvider`.
- `apps/mobile/src/storage.ts`, `badge*.{ts,native.ts}`, `linking.ts` -
  secure storage, app badge, deep links.
- `apps/mobile/app.config.js`, `google-services.cjs` - Expo config; injects
  the Android Firebase config into release builds.

## Key interfaces

- Talks to the host's REST API exclusively (`/api/v1/*`, plus
  `/api/auth/sign-in/email` for sessions) with a bearer session token, a
  workspace header, and an `x-hitly-client` channel hint that the host folds
  into evidence (`hitly.evidence.v1` client field).
- Push: `NativePushProvider` requests the Expo push token for the app's EAS
  project and registers/deregisters it via
  `POST/DELETE /api/v1/push-tokens` (see [push.md](push.md)).
- Deep links use the custom scheme defined in `src/config.ts` and are
  verified by the host's `.well-known` routes on the web app side.

## How it talks to the others

- `apps/app` (the host) for everything: auth, inbox, decisions, push tokens.
- The Expo push service for notifications; FCM/APNs credentials live on the
  Expo side, not in this app.
- `@hitly/core` for shared decision types.

## Configuration (variable names only)

Build-time: `GOOGLE_SERVICES_JSON` (Android release builds), EAS build
profile variables. Server-side companion variables (set on `apps/app`, not
here): `HITLY_MOBILE_APP_ID`, `HITLY_IOS_TEAM_ID`, `HITLY_ANDROID_SHA256`
(deep-link verification), `HITLY_EXPO_ORIGIN` (CORS for Expo web),
`EXPO_ACCESS_TOKEN` (authorized push sends).

## Unconfirmed

- Release/signing pipeline details live in EAS (external), not in this repo.
