# Building the HITLy Android APK

`scripts/build-android-apk.sh` builds a signed release APK of the mobile app
(`net.hitly.app`, pointed at `https://cloud.hitly.net`) from the current checkout.
It is the only supported way to hand-build an APK; don't edit `apps/mobile/android/`
by hand, the script regenerates it on every run.

## Toolchain

- JDK 17 (Temurin 17.0.x), `JAVA_HOME` set
- Android SDK with platform 36, build-tools 36.0.0, NDK 27.1.12297006, `ANDROID_HOME` set
- Node 24, Yarn 1.22

## Signing

The release key is the one whose SHA-256 fingerprint is published in
`/.well-known/assetlinks.json` for `net.hitly.app`. Never commit it or its passwords,
and never generate a new one (that breaks App Links and in-place upgrades).
Provide it through env vars, or a file referenced by `HITLY_ANDROID_SIGNING_ENV`:

```
HITLY_ANDROID_KEYSTORE_FILE=/path/to/release.jks
HITLY_ANDROID_KEYSTORE_PASSWORD=...
HITLY_ANDROID_KEY_ALIAS=...
HITLY_ANDROID_KEY_PASSWORD=...
```

## Build

```bash
git checkout <commit>
HITLY_ANDROID_SIGNING_ENV=~/secrets/hitly-android/keystore.env \
HITLY_ANDROID_EXPECTED_CERT_SHA256=<fingerprint from assetlinks.json> \
  scripts/build-android-apk.sh
```

Steps the script runs: `yarn install --frozen-lockfile`, `expo prebuild -p android --clean`,
patch the generated `android/app/build.gradle` (release signing from env, `versionCode`),
set `reactNativeArchitectures` (default `arm64-v8a,x86_64`), `./gradlew assembleRelease`,
then `apksigner verify`.

Output: `apps/mobile/dist-android/hitly-<versionName>-<sha8>.apk`, plus the APK SHA-256 and
signer fingerprint on stdout.

- `versionName` comes from `apps/mobile/app.json` (`expo.version`).
- `versionCode` defaults to `git rev-list --count HEAD`, so later commits always upgrade
  in place. Override with `HITLY_ANDROID_VERSION_CODE`.
- Other options: `HITLY_ANDROID_ABIS`, `HITLY_ANDROID_OUT_DIR`, `HITLY_ALLOW_DIRTY=1`.

Not covered: push notifications (no `google-services.json` / Expo projectId, so the app
falls back to polling the inbox) and store publishing.
