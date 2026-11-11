# Push notifications (Expo / FCM)

## Purpose

Wake reviewers' phones when work arrives. The path is: host creates an
approval -> host sends an Expo push ticket -> the Expo push service relays to
APNs (iOS) or FCM (Android) -> the Expo Router app opens the referenced
approval via deep link. FCM and APNs credentials live on the Expo/EAS side;
the repo never holds vendor push keys.

## Where it lives

Host side (`apps/app`):

- `lib/push.ts` - builds notification copy, sends to the public Expo push
  service (send + receipt endpoints, with a request timeout), prunes stale
  tokens from receipts.
- `lib/push-tokens.ts` - token store operations (register, list, delete).
- `app/api/v1/push-tokens/route.ts` - `POST`/`DELETE` token registration for
  the authenticated mobile user; `app/api/v1/devices/route.ts` lists devices.
- `lib/notify.ts` - the fan-out that pairs this with email
  ([email.md](email.md)).
- `lib/devices.ts` - device bookkeeping.

Mobile side (`apps/mobile`):

- `src/providers/NativePushProvider.tsx` - requests the Expo push token for
  the app's EAS project id and registers it with the host; handles
  permission state and deregistration.
- `src/api/hitly-client.ts` - the `POST/DELETE /api/v1/push-tokens` calls.
- `src/providers/NotificationProvider*.tsx`,
  `LinkNotificationProvider.tsx` - react to taps and route to the approval.
- `google-services.cjs`, `app.config.js` - wire the Android Firebase config
  (`GOOGLE_SERVICES_JSON`) into release builds for FCM.

## Data model

`packages/db`: `push_tokens` (device tokens bound to users) and
`user_devices` (device bookkeeping). Tokens removed on logout or when the
Expo receipts report them stale.

## Key interfaces

- Registration: `POST /api/v1/push-tokens { token, platform }` /
  `DELETE { token }` with the reviewer's session token
  ([rest-api.md](rest-api.md)).
- Sending: batched ticket submission to the Expo push service; `delivered`
  and per-ticket reasons are logged to the project event log. Sending
  failures never fail approval creation.
- Taps deep-link into the inbox via the custom scheme; domain association
  files are served by the host's `.well-known` routes using the deep-link
  config variables below.

## Configuration (variable names only)

Host: `EXPO_ACCESS_TOKEN` (authorized sends), `HITLY_EXPO_ORIGIN` (CORS for
the Expo web target). Deep-link verification (same `.well-known` routes):
`HITLY_MOBILE_APP_ID`, `HITLY_IOS_TEAM_ID`, `HITLY_ANDROID_SHA256`.
Mobile build-time: `GOOGLE_SERVICES_JSON` (Android release builds).

## Unconfirmed

- The EAS project / Expo account owning APNs and FCM credentials is external
  to this repo.
