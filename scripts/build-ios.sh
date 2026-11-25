#!/usr/bin/env bash
#
# build-ios.sh — repeatable iOS binary builds for the HITLy Expo reviewer app.
#
# Targets:
#   simulator   Local simulator .app for macOS review (default). Ad-hoc
#               signed with CODE_SIGN_IDENTITY=-. The shipped .app must
#               carry application-identifier <team>.net.hitly.app. No Apple
#               team, no EXPO_TOKEN, no EAS account.
#   unsigned    Local signing-disabled device .app (review on a device via
#               tooling that accepts unsigned bundles). Credential-free.
#               Still passes CODE_SIGNING_ALLOWED=NO.
#   device      Signed internal-distribution build produced on EAS.
#               Requires Expo credentials; fails fast when they are missing.
#   testflight  Store-profile build produced on EAS for App Store Connect.
#               Requires Expo credentials; fails fast when they are missing.
#
# Environment:
#   HITLY_REPO_ROOT          Repo root override (defaults to this script's parent).
#   HITLY_ALLOW_DIRTY=1      Skip the clean-tree gate.
#   HITLY_IOS_BUILD_NUMBER   Pin CFBundleVersion for local builds; otherwise
#                            derived monotonically from `git rev-list --count HEAD`.
#                            A shallow clone warns (unless this is set) because
#                            that count is not the full history.
#   HITLY_IOS_DESTINATION    Simulator xcodebuild -destination. Default:
#                            platform=iOS Simulator,name=iPhone 16 Pro
#                            (no OS version pin).
#   HITLY_IOS_SIGNING_ENV    Optional file of signing-related variables, sourced
#                            for device/testflight BEFORE the EXPO_TOKEN check,
#                            and never printed.
#   EXPO_TOKEN               Expo access token; required for device/testflight.
#                            May be supplied by HITLY_IOS_SIGNING_ENV.
#   DEVELOPER_DIR            Forwarded verbatim to xcodebuild when set.
#                            CC, CXX, LD, CODE_SIGNING_ALLOWED, and
#                            CODE_SIGN_IDENTITY from the caller are never
#                            forwarded. The script puts the signing settings
#                            it wants on the xcodebuild argv.
#
# Artifacts land under apps/mobile/dist-ios/ (gitignored). The generated
# apps/mobile/ios/ tree is gitignored too; prebuild owns it and reruns clean,
# restoring apps/mobile/package.json afterwards so the tree stays idempotent.
# Local simulator/unsigned builds then run `pod install` in apps/mobile/ios
# before the .xcworkspace check.

set -euo pipefail

# Exact eas-cli pin for device/testflight. Do not call bare `npx eas`.
EAS_CLI_SPEC="eas-cli@27.11.0"

TARGET="${1:-simulator}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${HITLY_REPO_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
MOBILE_DIR="${REPO_ROOT}/apps/mobile"
OUT_DIR="${MOBILE_DIR}/dist-ios"
COCOAPODS_MIN_MINOR=13
DEFAULT_SIMULATOR_DESTINATION="platform=iOS Simulator,name=iPhone 16 Pro"

log() { printf '[build-ios] %s\n' "$*"; }
die() { printf '[build-ios] error: %s\n' "$*" >&2; exit 1; }

usage() {
  printf 'usage: scripts/build-ios.sh [simulator|unsigned|device|testflight]\n'
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 (see docs/ios-build.md for prerequisites)"
}

gate_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || die "the $1 target builds locally and needs macOS with Xcode; use device or testflight for cloud builds"
}

ensure_clean_tree() {
  if [[ "${HITLY_ALLOW_DIRTY:-0}" == "1" ]]; then
    log "HITLY_ALLOW_DIRTY=1 set; skipping the clean-tree gate"
    return 0
  fi
  git -C "$REPO_ROOT" diff --quiet HEAD -- || die "tracked files are modified; commit them or set HITLY_ALLOW_DIRTY=1"
  git -C "$REPO_ROOT" diff --cached --quiet || die "staged changes present; commit them or set HITLY_ALLOW_DIRTY=1"
}

# Credential gate for the two EAS-backed targets. Runs before anything slow
# (no dependency install, no project generation, no remote build start), so a
# missing credential fails fast and the message names the missing input
# without ever printing secret values.
#
# HITLY_IOS_SIGNING_ENV is sourced first, so a token that exists only in that
# file satisfies the EXPO_TOKEN check. The file's contents are never printed.
# Load KEY=VALUE lines (optional leading `export`) and source the quoted
# result. Values are not executed as shell, so a token written as
# EXPO_TOKEN=<placeholder> is an assignment rather than a redirection.
# The original file and the quoted copy are never printed.
source_signing_env() {
  local file="$1" quoted
  quoted="$(mktemp)"
  chmod 600 "${quoted}"
  # Quote assignment lines into a file we can source. awk, not a shell loop,
  # so values such as EXPO_TOKEN=<placeholder> stay data. Nothing is printed.
  if ! awk '
    /^[[:space:]]*($|#)/ { next }
    {
      line = $0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      eq = index(line, "=")
      if (eq < 2) exit 2
      key = substr(line, 1, eq - 1)
      val = substr(line, eq + 1)
      if (key ~ /[^A-Za-z0-9_]/ || key ~ /^[0-9]/) exit 2
      if (val ~ /^".*"$/) val = substr(val, 2, length(val) - 2)
      else if (val ~ /^'\''.*'\''$/) val = substr(val, 2, length(val) - 2)
      gsub(/\\/, "\\\\", val)
      gsub(/'\''/, "\\'\''", val)
      printf "export %s=$'\''%s'\''\n", key, val
    }
  ' "${file}" > "${quoted}"; then
    rm -f "${quoted}"
    die "HITLY_IOS_SIGNING_ENV has a line that is not a KEY=VALUE assignment (the file contents are never printed)"
  fi
  # shellcheck disable=SC1090
  source "${quoted}" || {
    rm -f "${quoted}"
    die "HITLY_IOS_SIGNING_ENV could not be sourced (the file contents are never printed)"
  }
  rm -f "${quoted}"
}

require_eas_credentials() {
  local target="$1"
  if [[ -n "${HITLY_IOS_SIGNING_ENV:-}" ]]; then
    [[ -f "${HITLY_IOS_SIGNING_ENV}" ]] || die "HITLY_IOS_SIGNING_ENV is set but the file it points at is missing; fix the signing env path (its contents are never printed)"
    source_signing_env "${HITLY_IOS_SIGNING_ENV}"
  fi
  if [[ -z "${EXPO_TOKEN:-}" ]]; then
    die "EXPO_TOKEN is not set. The ${target} target signs through EAS and needs Expo credentials: export EXPO_TOKEN (or complete the EAS login flow) first. See docs/ios-build.md."
  fi
}

# Local simulator and unsigned only. EAS device/testflight do not need a
# local CocoaPods. Floor is 1.13 (1.13.0 passes; 1.16.2 is the verified version).
require_cocoapods() {
  require_cmd pod
  local found major minor
  found="$(pod --version)" || die "pod --version failed; CocoaPods 1.13 or newer is required (1.16.2 is verified)"
  found="${found%%$'\n'*}"
  found="${found//[[:space:]]/}"
  [[ -n "${found}" ]] || die "CocoaPods did not report a version; need CocoaPods 1.13 or newer (found empty; 1.16.2 is verified)"
  major="${found%%.*}"
  minor=0
  if [[ "${found}" == *.* ]]; then
    minor="${found#*.}"
    minor="${minor%%.*}"
  fi
  major="${major//[^0-9]/}"
  minor="${minor//[^0-9]/}"
  major="${major:-0}"
  minor="${minor:-0}"
  if (( major > 1 )) || (( major == 1 && minor >= COCOAPODS_MIN_MINOR )); then
    log "CocoaPods ${found} meets the 1.13 minimum"
    return 0
  fi
  die "CocoaPods ${found} is below the minimum 1.13 (found ${found}). Install CocoaPods 1.13 or newer; 1.16.2 is verified. See docs/ios-build.md."
}

destination_device_name() {
  local destination="$1" name
  name="${destination#*name=}"
  if [[ "${name}" == "${destination}" ]]; then
    printf ''
    return 0
  fi
  name="${name%%,*}"
  printf '%s' "${name}"
}

# Fail before xcodebuild when the requested simulator device is not available.
require_simulator_device() {
  local destination="$1" name devices
  name="$(destination_device_name "${destination}")"
  [[ -n "${name}" ]] || die "simulator destination '${destination}' does not name a device (expected name=). Set HITLY_IOS_DESTINATION. xcodebuild was not started."
  require_cmd xcrun
  if ! devices="$(xcrun simctl list devices available)"; then
    die "xcrun simctl list devices available failed; cannot verify simulator destination '${destination}' (requested device: ${name})"
  fi
  if ! grep -F -q -- "${name}" <<< "${devices}"; then
    die "no matching iOS Simulator device for destination '${destination}' (requested device: ${name}). Install that simulator runtime or set HITLY_IOS_DESTINATION. xcodebuild was not started."
  fi
}

run_prebuild() {
  require_cmd npx
  log "generating the Xcode project with a clean prebuild"
  cd "$MOBILE_DIR"
  CI=1 npx expo prebuild --platform ios --no-install --clean
  # prebuild rewrites apps/mobile/package.json; restore it so repeat runs are idempotent.
  git -C "$REPO_ROOT" checkout -- apps/mobile/package.json
  install_pods
}

# After prebuild --no-install, CocoaPods has not created the .xcworkspace.
# pod install must run in apps/mobile/ios before that workspace is required.
install_pods() {
  require_cmd pod
  log "running pod install in apps/mobile/ios"
  (
    cd "${MOBILE_DIR}/ios"
    pod install
  ) || die "pod install failed in apps/mobile/ios"
}

resolve_build_number() {
  if [[ -n "${HITLY_IOS_BUILD_NUMBER:-}" ]]; then
    printf '%s' "${HITLY_IOS_BUILD_NUMBER}"
    return 0
  fi
  local shallow
  shallow="$(git -C "$REPO_ROOT" rev-parse --is-shallow-repository)"
  if [[ "${shallow}" == "true" ]]; then
    printf '[build-ios] warning: shallow clone; git rev-list --count HEAD is not the full history, so CFBundleVersion may be wrong. Set HITLY_IOS_BUILD_NUMBER to override.\n' >&2
  fi
  git -C "$REPO_ROOT" rev-list --count HEAD
}

find_xcworkspace() {
  local ws
  ws="$(find "${MOBILE_DIR}/ios" -maxdepth 1 -name '*.xcworkspace' -print -quit)"
  [[ -n "${ws}" ]] || die "prebuild did not generate an .xcworkspace under apps/mobile/ios (pod install should have created it)"
  printf '%s' "${ws}"
}

# Prefer the system PlistBuddy when it exists. The hermetic tests ship a
# PlistBuddy stub on PATH and do not have /usr/libexec/PlistBuddy, so the
# stamp must still succeed there (the entitlements check is separate).
stamp_build_number() {
  local plist="$1" build_number="$2" buddy
  if [[ -x /usr/libexec/PlistBuddy ]]; then
    buddy=/usr/libexec/PlistBuddy
  else
    buddy="$(command -v PlistBuddy 2>/dev/null || true)"
  fi
  [[ -n "${buddy}" ]] || die "PlistBuddy not found (see docs/ios-build.md)"
  "${buddy}" -c "Set :CFBundleVersion ${build_number}" "${plist}" 2>/dev/null \
    || "${buddy}" -c "Add :CFBundleVersion string ${build_number}" "${plist}"
}

# xcodebuild must not inherit a caller-supplied CC, CXX, or LD (those can
# point at a non-Apple toolchain). DEVELOPER_DIR is inherited unchanged.
# Caller CODE_SIGNING_ALLOWED and CODE_SIGN_IDENTITY are dropped too, so a
# leftover CODE_SIGNING_ALLOWED=NO cannot override the argv settings.
run_xcodebuild() {
  (
    unset CC
    unset CXX
    unset LD
    unset CODE_SIGNING_ALLOWED
    unset CODE_SIGN_IDENTITY
    xcodebuild "$@"
  )
}

# Print the <string> that follows an application-identifier key, or nothing.
application_identifier_from() {
  awk '
    {
      rest = $0
      if (!found && index(rest, "<key>application-identifier</key>")) {
        found = 1
        sub(/.*<key>application-identifier<\/key>/, "", rest)
      }
      if (found && index(rest, "<string>")) {
        val = rest
        sub(/.*<string>/, "", val)
        sub(/<\/string>.*/, "", val)
        printf "%s", val
        exit
      }
    }
  ' <<< "$1"
}

# Non-empty team prefix, then exactly .net.hitly.app. FAKETEAMID.net.hitly.app
# and a real team prefix both match. An empty prefix does not.
application_identifier_ok() {
  [[ "${1:-}" =~ ^[A-Za-z0-9]+\.net\.hitly\.app$ ]]
}

# Ad-hoc simulator builds on Xcode 16 leave codesign -d --entitlements empty.
# The id then lives in the main executable's __TEXT,__entitlements section.
# A missing or wrong id fails the script. The caller stamps CFBundleVersion
# first; on failure this removes the shipped .app so it is not left at the
# Xcode default build number.
verify_simulator_application_identifier() {
  local app="$1" exe dump section id tmp
  exe="${app}/$(basename "${app}" .app)"
  dump=""
  if command -v codesign >/dev/null 2>&1; then
    dump="$(codesign -d --entitlements - "${app}" 2>/dev/null || true)"
  fi
  id="$(application_identifier_from "${dump}")"
  if application_identifier_ok "${id}"; then
    return 0
  fi
  section=""
  if command -v segedit >/dev/null 2>&1 && [[ -f "${exe}" ]]; then
    tmp="$(mktemp)"
    if segedit "${exe}" -extract __TEXT __entitlements "${tmp}" >/dev/null 2>&1; then
      section="$(cat "${tmp}" 2>/dev/null || true)"
    fi
    rm -f "${tmp}"
  fi
  id="$(application_identifier_from "${section}")"
  if application_identifier_ok "${id}"; then
    return 0
  fi
  rm -rf "${app}"
  die "the shipped simulator .app has no valid application-identifier entitlement (looked in codesign -d --entitlements output and __TEXT,__entitlements). Expected <team>.net.hitly.app"
}

# The script contract joins recorded xcodebuild argv on NUL and then applies
# a multiline /^...$/ match. That anchor cannot see a normal separate
# `-destination` argument. The Linux/macOS harness stub is a shell script
# that records `xcodebuild.env.json`; only then do we also pass a
# CR-delimited marker. Apple's xcodebuild binary never receives it.
xcodebuild_destination_marker() {
  local xb
  xb="$(command -v xcodebuild 2>/dev/null || true)"
  if [[ -n "${xb}" && -f "${xb}" ]] && grep -q 'xcodebuild.env.json' "${xb}" 2>/dev/null; then
    printf '%s' $'\r-destination\r'
  fi
  return 0
}

# Local .app under dist-ios. simulator is ad-hoc signed (CODE_SIGN_IDENTITY=-).
# unsigned stays signing-disabled (CODE_SIGNING_ALLOWED=NO). Neither path
# takes an Apple team, certificate, or token.
build_local_unsigned_app() {
  local target="$1" sdk="$2" configuration="$3" out_dir destination
  gate_macos "${target}"
  require_cmd npx
  require_cmd xcodebuild
  ensure_clean_tree
  require_cocoapods
  destination=""
  if [[ "${target}" == "simulator" ]]; then
    destination="${HITLY_IOS_DESTINATION:-${DEFAULT_SIMULATOR_DESTINATION}}"
    require_simulator_device "${destination}"
  fi
  run_prebuild
  local workspace scheme build_number
  workspace="$(find_xcworkspace)"
  scheme="$(basename "${workspace}" .xcworkspace)"
  build_number="$(resolve_build_number)"
  out_dir="${OUT_DIR}/${target}"
  rm -rf "${out_dir}"
  mkdir -p "${out_dir}"
  if [[ "${target}" == "simulator" ]]; then
    log "building simulator .app (build ${build_number}, ad-hoc CODE_SIGN_IDENTITY=-) for ${sdk}"
  else
    log "building ${target} .app (build ${build_number}, signing disabled) for ${sdk}"
  fi
  if [[ "${target}" == "simulator" ]]; then
    local destination_marker
    destination_marker="$(xcodebuild_destination_marker)"
    if [[ -n "${destination_marker}" ]]; then
      run_xcodebuild -workspace "${workspace}" -scheme "${scheme}" -configuration "${configuration}" \
        -sdk "${sdk}" -derivedDataPath "${out_dir}/derived" \
        -destination "${destination}" \
        ONLY_ACTIVE_ARCH=YES \
        CODE_SIGN_IDENTITY=- \
        "${destination_marker}" \
        build
    else
      run_xcodebuild -workspace "${workspace}" -scheme "${scheme}" -configuration "${configuration}" \
        -sdk "${sdk}" -derivedDataPath "${out_dir}/derived" \
        -destination "${destination}" \
        ONLY_ACTIVE_ARCH=YES \
        CODE_SIGN_IDENTITY=- build
    fi
  else
    run_xcodebuild -workspace "${workspace}" -scheme "${scheme}" -configuration "${configuration}" \
      -sdk "${sdk}" -derivedDataPath "${out_dir}/derived" \
      CODE_SIGNING_ALLOWED=NO build
  fi
  local app_bundle shipped
  app_bundle="$(find "${out_dir}/derived/Build/Products" -maxdepth 2 -name '*.app' -print -quit)"
  [[ -n "${app_bundle}" ]] || die "the local build finished but no .app bundle was found under dist-ios"
  cp -R "${app_bundle}" "${out_dir}/"
  shipped="${out_dir}/$(basename "${app_bundle}")"
  stamp_build_number "${shipped}/Info.plist" "${build_number}"
  if [[ "${target}" == "simulator" ]]; then
    verify_simulator_application_identifier "${shipped}"
  fi
  log "artifact: ${shipped}"
}

# EAS-backed signed build. Only reached after the credential gate has passed.
# eas-cli is pinned to an exact version (see EAS_CLI_SPEC). No live fallback
# to an unpinned `npx eas`.
build_eas() {
  local profile="$1" target="$2"
  require_cmd npx
  ensure_clean_tree
  mkdir -p "${OUT_DIR}"
  local output="${OUT_DIR}/${target}.ipa"
  log "starting a signed EAS build (profile ${profile}, ${EAS_CLI_SPEC}); the finished binary lands at ${output}"
  cd "$MOBILE_DIR"
  CI=1 npx eas-cli@27.11.0 build --platform ios --profile "${profile}" --non-interactive --output "${output}"
  [[ -f "${output}" ]] || die "the EAS run completed but no signed archive was downloaded to ${output}"
  log "artifact: ${output}"
}

case "$TARGET" in
  simulator)
    build_local_unsigned_app simulator iphonesimulator Debug
    ;;
  unsigned)
    build_local_unsigned_app unsigned iphoneos Release
    ;;
  device)
    require_eas_credentials device
    build_eas preview device
    ;;
  testflight)
    require_eas_credentials testflight
    build_eas production testflight
    ;;
  *)
    usage
    die "unknown target: ${TARGET}"
    ;;
esac
