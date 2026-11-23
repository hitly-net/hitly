#!/usr/bin/env bash
#
# build-ios.sh — repeatable iOS binary builds for the HITLy Expo reviewer app.
#
# Targets:
#   simulator   Local simulator .app for macOS review (default). No Apple
#               credentials, no EXPO_TOKEN, no EAS account needed.
#   unsigned    Local signing-disabled device .app (ad-hoc review on a
#               device via tooling that accepts unsigned bundles).
#               Also credential-free.
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
#   HITLY_IOS_SIGNING_ENV    Optional file of signing-related variables, sourced
#                            for device/testflight and never printed.
#   EXPO_TOKEN               Expo access token; required for device/testflight.
#
# Artifacts land under apps/mobile/dist-ios/ (gitignored). The generated
# apps/mobile/ios/ tree is gitignored too; prebuild owns it and reruns clean,
# restoring apps/mobile/package.json afterwards so the tree stays idempotent.

set -euo pipefail

TARGET="${1:-simulator}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${HITLY_REPO_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
MOBILE_DIR="${REPO_ROOT}/apps/mobile"
OUT_DIR="${MOBILE_DIR}/dist-ios"

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
require_eas_credentials() {
  local target="$1"
  if [[ -z "${EXPO_TOKEN:-}" ]]; then
    die "EXPO_TOKEN is not set. The ${target} target signs through EAS and needs Expo credentials: export EXPO_TOKEN (or complete the EAS login flow) first. See docs/ios-build.md."
  fi
  if [[ -n "${HITLY_IOS_SIGNING_ENV:-}" ]]; then
    [[ -f "${HITLY_IOS_SIGNING_ENV}" ]] || die "HITLY_IOS_SIGNING_ENV is set but the file it points at is missing; fix the signing env path (its contents are never printed)"
    # shellcheck disable=SC1090
    source "${HITLY_IOS_SIGNING_ENV}"
  fi
}

run_prebuild() {
  require_cmd npx
  log "generating the Xcode project with a clean prebuild"
  cd "$MOBILE_DIR"
  CI=1 npx expo prebuild --platform ios --no-install --clean
  # prebuild rewrites apps/mobile/package.json; restore it so repeat runs are idempotent.
  git -C "$REPO_ROOT" checkout -- apps/mobile/package.json
}

resolve_build_number() {
  if [[ -n "${HITLY_IOS_BUILD_NUMBER:-}" ]]; then
    printf '%s' "${HITLY_IOS_BUILD_NUMBER}"
    return 0
  fi
  cd "$REPO_ROOT"
  git rev-list --count HEAD
}

find_xcworkspace() {
  local ws
  ws="$(find "${MOBILE_DIR}/ios" -maxdepth 1 -name '*.xcworkspace' -print -quit)"
  [[ -n "${ws}" ]] || die "prebuild did not generate an .xcworkspace under apps/mobile/ios"
  printf '%s' "${ws}"
}

stamp_build_number() {
  local plist="$1" build_number="$2"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${build_number}" "${plist}" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string ${build_number}" "${plist}"
}

# Local build with signing disabled: produces a .app bundle under dist-ios
# without any identity, certificate, or token.
build_local_unsigned_app() {
  local target="$1" sdk="$2" configuration="$3" out_dir
  gate_macos "${target}"
  require_cmd npx
  require_cmd xcodebuild
  ensure_clean_tree
  run_prebuild
  local workspace scheme build_number
  workspace="$(find_xcworkspace)"
  scheme="$(basename "${workspace}" .xcworkspace)"
  build_number="$(resolve_build_number)"
  out_dir="${OUT_DIR}/${target}"
  rm -rf "${out_dir}"
  mkdir -p "${out_dir}"
  log "building ${target} .app (build ${build_number}, signing disabled) for ${sdk}"
  xcodebuild -workspace "${workspace}" -scheme "${scheme}" -configuration "${configuration}" \
    -sdk "${sdk}" -derivedDataPath "${out_dir}/derived" \
    CODE_SIGNING_ALLOWED=NO build
  local app_bundle
  app_bundle="$(find "${out_dir}/derived/Build/Products" -maxdepth 2 -name '*.app' -print -quit)"
  [[ -n "${app_bundle}" ]] || die "the local build finished but no .app bundle was found under dist-ios"
  cp -R "${app_bundle}" "${out_dir}/"
  stamp_build_number "${out_dir}/$(basename "${app_bundle}")/Info.plist" "${build_number}"
  log "artifact: ${out_dir}/$(basename "${app_bundle}")"
}

# EAS-backed signed build. Only reached after the credential gate has passed.
build_eas() {
  local profile="$1" target="$2"
  require_cmd npx
  ensure_clean_tree
  mkdir -p "${OUT_DIR}"
  local output="${OUT_DIR}/${target}.ipa"
  log "starting a signed EAS build (profile ${profile}); the finished binary lands at ${output}"
  cd "$MOBILE_DIR"
  CI=1 npx eas build --platform ios --profile "${profile}" --non-interactive --output "${output}"
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
