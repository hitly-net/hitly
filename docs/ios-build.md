# Building the HITLy iOS app

`scripts/build-ios.sh` builds a reviewable iOS binary of the mobile app
(`net.hitly.app`, associated domains on `https://cloud.hitly.net`) from the
current checkout. It is the only supported way to hand-build the iOS
artifacts; don't edit `apps/mobile/ios/` by hand — the script regenerates it
with a clean `expo prebuild` on every run and restores
`apps/mobile/package.json` afterwards, so repeat runs are idempotent.

## Targets

| Target | What it produces | Credentials |
| --- | --- | --- |
| `simulator` (default) | Unsigned `.app` for the iOS simulator (local, via Xcode) | none |
| `unsigned` | Signing-disabled device `.app` for local ad-hoc-style review (local, via Xcode) | none |
| `device` | Signed internal-distribution `.ipa` built on EAS (`preview` profile) | Expo credentials |
| `testflight` | Store-profile `.ipa` for App Store Connect (EAS `production` profile) | Expo credentials |

`simulator` and `unsigned` run locally with signing disabled: they work with
no Apple credentials of any kind — no certificate, no provisioning profile,
no `EXPO_TOKEN` — on any Mac with Xcode. `device` and `testflight` sign
through EAS; both fail fast —
before any install, prebuild, or remote build starts — when the documented
credentials are missing, and never print secret values.

## Toolchain

- macOS with Xcode (the version matching Expo SDK 54) for the local
  `simulator` and `unsigned` targets
- Node 22 and Yarn 1.22 (`yarn install --frozen-lockfile` first, from the
  repo root)
- For `device` / `testflight`: the EAS CLI is invoked through `npx`; the
  build runs on Expo Application Services

## Apple prerequisites (signed paths only)

The credential-gated targets need an Apple Developer Program membership and
signing material managed by EAS:

- An Expo account the `EXPO_TOKEN` belongs to, with access to the HITLy EAS
  project (project id `f6c17c55-3708-402c-8ced-95030bf1e5e5`, injected as
  `extra.eas.projectId` by `apps/mobile/app.config.js`).
- An Apple Developer account whose distribution certificate and provisioning
  profiles EAS can use for `net.hitly.app` (EAS credentials source, or
  credentials you have uploaded with the EAS CLI).
- For `testflight`: App Store Connect (ASC) access for the HITLy app record so
  the uploaded build appears for internal testing and review. Export
  compliance is answered up front via
  `ITSAppUsesNonExemptEncryption: false` in `apps/mobile/app.json`.

Provide credentials through your environment, or a file referenced by
`HITLY_IOS_SIGNING_ENV` (sourced by the script, contents never printed):

```
export EXPO_TOKEN=<your-token-from-expo>
# optional extra signing variables, kept out of the repo:
HITLY_IOS_SIGNING_ENV=~/secrets/hitly-ios/signing.env
```

Never commit tokens, certificates (`.p12`), keys (`.p8`), or provisioning
profiles (`.mobileprovision`); `.gitignore` already blocks them along with
the generated `apps/mobile/ios/` tree and `credentials.json`.

## Build

Local, credential-free (simulator — the default target):

```bash
git checkout <commit>
scripts/build-ios.sh              # same as: scripts/build-ios.sh simulator
```

Local signing-disabled device build:

```bash
scripts/build-ios.sh unsigned
```

Signed internal build for physical devices (EAS):

```bash
export EXPO_TOKEN=<your-token-from-expo>
scripts/build-ios.sh device
```

TestFlight submission build (EAS):

```bash
export EXPO_TOKEN=<your-token-from-expo>
scripts/build-ios.sh testflight
```

Steps the script runs: a dirty-tree gate (override with `HITLY_ALLOW_DIRTY=1`),
the credential gate for the signed targets, then either a local path
(`CI=1 npx expo prebuild --platform ios --no-install --clean`, restore
`apps/mobile/package.json`, `xcodebuild` with `CODE_SIGNING_ALLOWED=NO`) or a
remote EAS build (`npx eas build --platform ios --profile <profile>
--non-interactive`).

Output lands under `apps/mobile/dist-ios/` (gitignored):

- `simulator/HITLy.app` and `unsigned/HITLy.app` for the local targets, with
  `CFBundleVersion` stamped from the build number.
- `device.ipa` and `testflight.ipa` for the EAS targets.

Build numbers:

- Local builds derive `CFBundleVersion` from `git rev-list --count HEAD`, so
  later commits always produce higher build numbers. Override with
  `HITLY_IOS_BUILD_NUMBER`.
- EAS builds use `autoIncrement: true` in `apps/mobile/eas.json` for the
  `preview` and `production` profiles; the short version stays
  `expo.version` in `apps/mobile/app.json`.

Other options: `HITLY_REPO_ROOT` (repo root override), `HITLY_ALLOW_DIRTY=1`,
`HITLY_IOS_SIGNING_ENV`.

## Push (unchanged client path)

APNs push continues through `expo-notifications` and the existing EAS project;
this build path changes nothing about the push registration flow or the
`ExponentPushToken[...]` format the server stores. Google/Firebase
`google-services.json` remains an Android-only concern — iOS builds (including
EAS simulator builds) do not require `GOOGLE_SERVICES_JSON`.

Not covered: creating the App Store Connect listing, store copy, screenshots,
and actual store submission beyond uploading the signed archive.
