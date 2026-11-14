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

## Push (google-services.json)

FCM / Expo push needs a Firebase `google-services.json` at build time. The script
does not commit that file (`google-services.json` is already in `.gitignore`).
Point `GOOGLE_SERVICES_JSON` at your copy; the script stages it into
`apps/mobile/google-services.json` before `expo prebuild`, and again into
`apps/mobile/android/app/google-services.json` after the generated tree is
recreated. Wiring `expo.android.googleServicesFile` and `extra.eas.projectId`
in app config is a separate change; the script only makes the file available.

```
GOOGLE_SERVICES_JSON=/path/to/google-services.json
```

If `GOOGLE_SERVICES_JSON` is unset, the script warns and builds without push
(the app can still poll the inbox). If the path is set but the file is missing
or not valid JSON, the script fails. To require push (fail instead of warn when
the variable is unset):

```
HITLY_ANDROID_REQUIRE_PUSH=1
```

Never print or commit the file contents.

## Build

```bash
git checkout <commit>
HITLY_ANDROID_SIGNING_ENV=~/secrets/hitly-android/keystore.env \
HITLY_ANDROID_EXPECTED_CERT_SHA256=<fingerprint from assetlinks.json> \
GOOGLE_SERVICES_JSON=~/secrets/hitly-firebase/google-services.json \
  scripts/build-android-apk.sh
```

Steps the script runs: `yarn install --frozen-lockfile`, stage `google-services.json`
when provided, `expo prebuild -p android --clean`, restage the file in the generated
`android/` tree, patch the generated `android/app/build.gradle` (release signing from
env, `versionCode`), set `reactNativeArchitectures` (default `arm64-v8a,x86_64`),
`./gradlew assembleRelease`, then `apksigner verify`.

Output: `apps/mobile/dist-android/hitly-<versionName>-<sha8>.apk`, plus the APK SHA-256 and
signer fingerprint on stdout.

- `versionName` comes from `apps/mobile/app.json` (`expo.version`).
- `versionCode` defaults to `git rev-list --count HEAD`, so later commits always upgrade
  in place. Override with `HITLY_ANDROID_VERSION_CODE`.
- Other options: `HITLY_ANDROID_ABIS`, `HITLY_ANDROID_OUT_DIR`, `HITLY_ALLOW_DIRTY=1`,
  `GOOGLE_SERVICES_JSON`, `HITLY_ANDROID_REQUIRE_PUSH=1`.

Not covered: Expo projectId / `googleServicesFile` app-config wiring, and store publishing.
