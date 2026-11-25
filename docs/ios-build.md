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
| `simulator` (default) | Ad-hoc signed Debug `.app` for the iOS simulator (`CODE_SIGN_IDENTITY=-`, local, via Xcode) | none |
| `unsigned` | Signing-disabled device `.app` for local review (local, via Xcode) | none |
| `device` | Signed internal-distribution `.ipa` built on EAS (`preview` profile) | Expo credentials |
| `testflight` | Store-profile `.ipa` for App Store Connect (EAS `production` profile) | Expo credentials |

`simulator` and `unsigned` run locally with no Apple credentials of any kind —
no Apple team, no certificate, no provisioning profile, no `EXPO_TOKEN` — on
any Mac with Xcode. `simulator` is ad-hoc signed (`CODE_SIGN_IDENTITY=-`).
`unsigned` stays signing-disabled. `device` and `testflight` sign
through EAS; both fail fast —
before any install, prebuild, or remote build starts — when the documented
credentials are missing, and never print secret values.

## Toolchain

- macOS with Xcode (the version matching Expo SDK 54) for the local
  `simulator` and `unsigned` targets
- Node 22 and Yarn 1.22 (`yarn install --frozen-lockfile` first, from the
  repo root)
- CocoaPods **1.13** or newer for the local `simulator` and `unsigned`
  targets only (not for EAS `device` / `testflight`). The script runs
  `pod --version` and refuses to prebuild when the installed CocoaPods is
  below 1.13, naming both the 1.13 floor and the version it found.
  CocoaPods **1.16.2** is the verified version (1.13.0 and 1.16.2 both pass).
- For `device` / `testflight`: a pinned EAS CLI, `eas-cli@27.11.0`, invoked
  as `npx eas-cli@27.11.0` (not an unpinned `npx eas`). The build runs on
  Expo Application Services. There is no live fallback to a floating CLI.

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
`HITLY_IOS_SIGNING_ENV`. When that variable is set, the script loads that
file **before** it tests whether `EXPO_TOKEN` is present, so a token that
exists only in the file passes the gate. The file is assignment lines
(`KEY=value` or `export KEY=value`), which are shell-quoted and then
sourced; it is not run as an arbitrary shell script, and its contents are
never printed. If the variable is set and the file is missing, the script
exits naming `HITLY_IOS_SIGNING_ENV` and does not print the file:

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
the credential gate for the signed targets (signing env sourced first, then
`EXPO_TOKEN`), then either a local path or a remote EAS build.

Local path, for `simulator` and `unsigned`:

1. CocoaPods preflight (`pod --version`, minimum 1.13) before prebuild.
2. For `simulator` only, a runtime preflight (`xcrun simctl list devices available`).
   If the requested device is not listed, the script fails and does not run
   `xcodebuild`.
3. `CI=1 npx expo prebuild --platform ios --no-install --clean`, then restore
   `apps/mobile/package.json`.
4. `pod install` in `apps/mobile/ios` (prebuild is `--no-install`, so the
   `.xcworkspace` does not exist until this step). A failed `pod install`
   exits non-zero and the error names `pod install`.
5. `xcodebuild`. Caller `CC`, `CXX`, and `LD` are unset for that process so a
   foreign compiler cannot replace Apple clang. Caller `CODE_SIGNING_ALLOWED`
   and `CODE_SIGN_IDENTITY` are unset as well, so a leftover environment
   cannot override the settings below. `DEVELOPER_DIR` is forwarded verbatim
   when it is set.
   - `simulator` passes `CODE_SIGN_IDENTITY=-` (ad-hoc). It does not pass
     `CODE_SIGNING_ALLOWED=NO`, and it does not need an Apple team.
   - `unsigned` passes `CODE_SIGNING_ALLOWED=NO`.

The simulator `xcodebuild` also passes a concrete `-destination` and
`ONLY_ACTIVE_ARCH=YES`. The default destination is
`platform=iOS Simulator,name=iPhone 16 Pro` (no OS version is pinned).
Override it with `HITLY_IOS_DESTINATION`.

After the simulator `.app` is copied to `dist-ios/simulator/`, the script
runs `codesign -d --entitlements` on that shipped bundle (not only the
`derived/` copy). The dump must contain `keychain-access-groups`. If it does
not, the script exits non-zero and names the entitlement. This check runs
before the `CFBundleVersion` stamp.

Remote path, for `device` and `testflight`:
`npx eas-cli@27.11.0 build --platform ios --profile <profile> --non-interactive`.

Output lands under `apps/mobile/dist-ios/` (gitignored):

- `simulator/HITLy.app` and `unsigned/HITLy.app` for the local targets, with
  `CFBundleVersion` stamped from the build number.
- `device.ipa` and `testflight.ipa` for the EAS targets.

The simulator `.app` is a **Debug** build. It has no embedded `main.jsbundle`.
A JavaScript UI needs Metro (`npx expo start`); opening the `.app` alone does
not load the JS bundle. A packager-less Debug launch may still show a LogBox
that no script URL was provided. That message is about Metro, not signing.

The official simulator path is ad-hoc signed (`CODE_SIGN_IDENTITY=-`) so the
`.app` embeds entitlements, including `keychain-access-groups` (needed by
`expo-secure-store`). `codesign -d --entitlements` on the shipped
`dist-ios/simulator/*.app` must show that key. A missing keychain entitlement
on this path is a build failure. The simulator target does not need an Apple
team, Apple ID, or `EXPO_TOKEN`.

The `unsigned` target stays signing-disabled (`CODE_SIGNING_ALLOWED=NO`). It
is not the official simulator path.

Build numbers:

- Local builds derive `CFBundleVersion` from `git rev-list --count HEAD`, so
  later commits always produce higher build numbers. Override with
  `HITLY_IOS_BUILD_NUMBER`. That `git rev-list --count HEAD` default is
  unchanged. Before trusting the count, the script checks
  `git rev-parse --is-shallow-repository`. On a shallow clone, with
  `HITLY_IOS_BUILD_NUMBER` unset, it warns on stderr that the shallow clone
  count is not the full history and names `HITLY_IOS_BUILD_NUMBER` as the
  override.
- EAS builds use `autoIncrement: true` in `apps/mobile/eas.json` for the
  `preview` and `production` profiles. `cli.appVersionSource` is `"local"`,
  and the short version stays `expo.version` in `apps/mobile/app.json`.
  With that local source, EAS `autoIncrement` on `preview` / `production`
  may rewrite `apps/mobile/app.json` and leave the worktree dirty. The next
  `scripts/build-ios.sh` run then refuses until that `app.json` change is
  committed or `HITLY_ALLOW_DIRTY=1` is set. The script does not auto-commit
  `app.json`.

Other options: `HITLY_REPO_ROOT` (repo root override), `HITLY_ALLOW_DIRTY=1`,
`HITLY_IOS_SIGNING_ENV`, `HITLY_IOS_DESTINATION`, `HITLY_IOS_BUILD_NUMBER`,
`DEVELOPER_DIR`.

## Push (unchanged client path)

APNs push continues through `expo-notifications` and the existing EAS project;
this build path changes nothing about the push registration flow or the
`ExponentPushToken[...]` format the server stores. Google/Firebase
`google-services.json` remains an Android-only concern — iOS builds (including
EAS simulator builds) do not require `GOOGLE_SERVICES_JSON`.

Not covered: creating the App Store Connect listing, store copy, screenshots,
and actual store submission beyond uploading the signed archive.
