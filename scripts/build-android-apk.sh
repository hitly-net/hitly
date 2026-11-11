#!/usr/bin/env bash
# Build a signed release APK of the HITLy mobile app (net.hitly.app).
#
# Repeatable local build: Expo prebuild -> patch generated android/ for release
# signing -> gradle assembleRelease. Nothing generated or secret is committed.
#
# Required (env vars, or put them in a file and point HITLY_ANDROID_SIGNING_ENV at it):
#   HITLY_ANDROID_KEYSTORE_FILE      path to the release keystore (.jks)
#   HITLY_ANDROID_KEYSTORE_PASSWORD  keystore password
#   HITLY_ANDROID_KEY_ALIAS          key alias
#   HITLY_ANDROID_KEY_PASSWORD       key password
# Optional:
#   HITLY_ANDROID_SIGNING_ENV    file with the four vars above (sourced, never printed)
#   HITLY_ANDROID_VERSION_CODE   default: git commit count of HEAD (monotonic)
#   HITLY_ANDROID_ABIS           default: arm64-v8a,x86_64
#   HITLY_ANDROID_EXPECTED_CERT_SHA256  if set, fail unless the APK signer matches
#   HITLY_ANDROID_OUT_DIR        default: <repo>/apps/mobile/dist-android
#   HITLY_ALLOW_DIRTY=1          build even if tracked files are modified
#   GOOGLE_SERVICES_JSON         path to Firebase google-services.json. Copied at
#                                build time into apps/mobile/google-services.json
#                                and, after prebuild, android/app/google-services.json.
#                                Never committed. App config (googleServicesFile,
#                                extra.eas.projectId) is wired separately.
#   HITLY_ANDROID_REQUIRE_PUSH=1 fail if GOOGLE_SERVICES_JSON is unset or unreadable
# Toolchain: JDK 17, Android SDK (platform 36, build-tools 36.0.0, NDK 27.1.12297006),
# Node 24, Yarn 1.22. JAVA_HOME and ANDROID_HOME must be set.
set -euo pipefail

REPO_ROOT="${HITLY_REPO_ROOT:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)}"
MOBILE="$REPO_ROOT/apps/mobile"
OUT_DIR="${HITLY_ANDROID_OUT_DIR:-$MOBILE/dist-android}"
ABIS="${HITLY_ANDROID_ABIS:-arm64-v8a,x86_64}"
GS_STAGED="$MOBILE/google-services.json"
GS_ANDROID="$MOBILE/android/app/google-services.json"

die() { echo "build-android-apk: $*" >&2; exit 1; }
warn() { echo "build-android-apk: warning: $*" >&2; }

if [[ -n "${HITLY_ANDROID_SIGNING_ENV:-}" ]]; then
  [[ -r "$HITLY_ANDROID_SIGNING_ENV" ]] || die "cannot read HITLY_ANDROID_SIGNING_ENV"
  set -a; # shellcheck disable=SC1090
  . "$HITLY_ANDROID_SIGNING_ENV"; set +a
fi
# Stage google-services.json from GOOGLE_SERVICES_JSON (a path). Never print contents.
# Push is optional: warn and continue when the file is absent, unless required.
stage_google_services() {
  local dest="$1" src_abs dest_abs
  src_abs="$(readlink -f "$GOOGLE_SERVICES_JSON")"
  mkdir -p "$(dirname "$dest")"
  dest_abs="$(readlink -f "$dest" 2>/dev/null || true)"
  if [[ -n "$dest_abs" && "$src_abs" == "$dest_abs" ]]; then
    return 0
  fi
  cp -f "$GOOGLE_SERVICES_JSON" "$dest"
  chmod 600 "$dest"
}

REQUIRE_PUSH="${HITLY_ANDROID_REQUIRE_PUSH:-0}"
HAVE_GOOGLE_SERVICES=0
if [[ -n "${GOOGLE_SERVICES_JSON:-}" ]]; then
  [[ -r "$GOOGLE_SERVICES_JSON" ]] || die "GOOGLE_SERVICES_JSON is not readable: $GOOGLE_SERVICES_JSON"
  if ! python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$GOOGLE_SERVICES_JSON" >/dev/null 2>&1; then
    die "GOOGLE_SERVICES_JSON is not valid JSON (contents not printed)"
  fi
  HAVE_GOOGLE_SERVICES=1
elif [[ "$REQUIRE_PUSH" == 1 ]]; then
  die "push is required (HITLY_ANDROID_REQUIRE_PUSH=1) but GOOGLE_SERVICES_JSON is not set"
else
  warn "GOOGLE_SERVICES_JSON not set; building without FCM push"
fi

for v in HITLY_ANDROID_KEYSTORE_FILE HITLY_ANDROID_KEYSTORE_PASSWORD HITLY_ANDROID_KEY_ALIAS HITLY_ANDROID_KEY_PASSWORD; do
  [[ -n "${!v:-}" ]] || die "$v is not set"
done
export HITLY_ANDROID_KEYSTORE_FILE HITLY_ANDROID_KEYSTORE_PASSWORD HITLY_ANDROID_KEY_ALIAS HITLY_ANDROID_KEY_PASSWORD
[[ -r "$HITLY_ANDROID_KEYSTORE_FILE" ]] || die "keystore file not readable"
[[ -n "${JAVA_HOME:-}" && -n "${ANDROID_HOME:-}" ]] || die "JAVA_HOME and ANDROID_HOME must be set"

cd "$REPO_ROOT"
if [[ "${HITLY_ALLOW_DIRTY:-0}" != 1 ]] && ! git diff --quiet HEAD --; then
  die "tracked files are modified; commit/stash or set HITLY_ALLOW_DIRTY=1"
fi
SHA="$(git rev-parse --short=8 HEAD)"
VERSION_CODE="${HITLY_ANDROID_VERSION_CODE:-$(git rev-list --count HEAD)}"
VERSION_NAME="$(node -p "require('$MOBILE/app.json').expo.version")"
echo "==> HITLy Android $VERSION_NAME ($VERSION_CODE) @ $SHA, ABIs $ABIS"
if [[ "$HAVE_GOOGLE_SERVICES" == 1 ]]; then
  stage_google_services "$GS_STAGED"
  echo "==> google-services.json staged at $GS_STAGED (gitignored, not committed)"
fi

yarn install --frozen-lockfile

cd "$MOBILE"
CI=1 npx expo prebuild --platform android --no-install --clean
# prebuild rewrites the "android"/"ios" scripts in package.json; keep the tree clean.
git -C "$REPO_ROOT" checkout -- apps/mobile/package.json

# After --clean prebuild, place the file where the Google Services plugin looks.
# App config wiring of googleServicesFile is separate; this just makes the file available.
if [[ "$HAVE_GOOGLE_SERVICES" == 1 ]]; then
  stage_google_services "$GS_STAGED"
  stage_google_services "$GS_ANDROID"
  echo "==> google-services.json also at $GS_ANDROID (generated tree, not committed)"
fi

# Patch generated android/ (regenerated on every run, never committed).
GRADLE_APP=android/app/build.gradle
node - "$GRADLE_APP" "$VERSION_CODE" <<'JS'
const fs = require('fs')
const [file, versionCode] = process.argv.slice(2)
let s = fs.readFileSync(file, 'utf8')
const release = `        release {
            storeFile file(System.getenv('HITLY_ANDROID_KEYSTORE_FILE'))
            storePassword System.getenv('HITLY_ANDROID_KEYSTORE_PASSWORD')
            keyAlias System.getenv('HITLY_ANDROID_KEY_ALIAS')
            keyPassword System.getenv('HITLY_ANDROID_KEY_PASSWORD')
        }
`
const sc = s.match(/(    signingConfigs \{\n        debug \{[\s\S]*?\n        \}\n)/)
if (!sc) throw new Error('signingConfigs block not found')
s = s.replace(sc[1], sc[1] + release)
const bt = s.indexOf('    buildTypes {')
const rel = s.indexOf('        release {', bt)
const dbg = s.indexOf('signingConfig signingConfigs.debug', rel)
if (bt < 0 || rel < 0 || dbg < 0) throw new Error('buildTypes.release signingConfig not found')
s = s.slice(0, dbg) + 'signingConfig signingConfigs.release' + s.slice(dbg + 'signingConfig signingConfigs.debug'.length)
if (!/versionCode \d+/.test(s)) throw new Error('versionCode not found')
s = s.replace(/versionCode \d+/, `versionCode ${Number(versionCode)}`)
fs.writeFileSync(file, s)
JS
{
  echo
  echo "# build-android-apk.sh"
  echo "reactNativeArchitectures=$ABIS"
  echo "org.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=1g"
} >> android/gradle.properties

(cd android && NODE_ENV=production ./gradlew --no-daemon assembleRelease)

APK_SRC=android/app/build/outputs/apk/release/app-release.apk
[[ -f "$APK_SRC" ]] || die "release APK not produced"
mkdir -p "$OUT_DIR"
APK="$OUT_DIR/hitly-$VERSION_NAME-$SHA.apk"
cp "$APK_SRC" "$APK"

APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -1)"
"$APKSIGNER" verify "$APK"
CERT="$("$APKSIGNER" verify --print-certs "$APK" | sed -n 's/.*certificate SHA-256 digest: //p' | head -1)"
if [[ -n "${HITLY_ANDROID_EXPECTED_CERT_SHA256:-}" ]]; then
  want="$(echo "$HITLY_ANDROID_EXPECTED_CERT_SHA256" | tr -d ':' | tr 'A-F' 'a-f')"
  [[ "$CERT" == "$want" ]] || die "signer $CERT does not match HITLY_ANDROID_EXPECTED_CERT_SHA256"
fi
echo "==> APK:         $APK"
echo "==> version:     $VERSION_NAME ($VERSION_CODE)"
echo "==> commit:      $(git -C "$REPO_ROOT" rev-parse HEAD)"
echo "==> APK sha256:  $(sha256sum "$APK" | cut -d' ' -f1)"
echo "==> signer cert sha256: $CERT"
if [[ "$HAVE_GOOGLE_SERVICES" == 1 ]]; then
  echo "==> FCM config:  google-services.json staged for this build"
else
  echo "==> FCM config:  not provided (built without push)"
fi
