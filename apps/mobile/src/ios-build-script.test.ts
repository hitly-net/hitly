import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const srcDir = dirname(fileURLToPath(import.meta.url))
const mobileDir = join(srcDir, '..')
const repoRoot = join(mobileDir, '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'build-ios.sh')
const docsPath = join(repoRoot, 'docs', 'ios-build.md')

type MockOpts = {
  target?: string
  podVersion?: string
  destination?: string | undefined
  shallow?: boolean
  cc?: string
  cxx?: string
  ld?: string
  developerDir?: string
  signingEnvContents?: string
  extraEnv?: Record<string, string>
}

type MockResult = {
  status: number | null
  stdout: string
  stderr: string
  out: string
  log: string
  args: string[]
  env: Record<string, string>
  tmp: string
}

function scriptText(): string {
  assert.ok(existsSync(scriptPath), 'scripts/build-ios.sh missing')
  return readFileSync(scriptPath, 'utf8')
}

function docsText(): string {
  assert.ok(existsSync(docsPath), 'docs/ios-build.md missing')
  return readFileSync(docsPath, 'utf8')
}

function writeExec(path: string, body: string) {
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o755 })
  chmodSync(path, 0o755)
}

function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').slice(0, 400)}`)
  return r
}

function initWorktree(tmp: string, shallow: boolean): string {
  const full = join(tmp, 'full')
  mkdirSync(join(full, 'apps', 'mobile'), { recursive: true })
  writeFileSync(
    join(full, 'apps', 'mobile', 'package.json'),
    `${JSON.stringify({ name: '@hitly/mobile', private: true, version: '0.0.2' }, null, 2)}\n`,
  )
  writeFileSync(
    join(full, 'apps', 'mobile', 'app.json'),
    `${JSON.stringify({ expo: { name: 'HITLy', slug: 'hitly', version: '0.0.2', ios: { bundleIdentifier: 'net.hitly.app' } } }, null, 2)}\n`,
  )
  writeFileSync(join(full, '.gitignore'), 'apps/mobile/ios/\napps/mobile/dist-ios/\n')
  git(full, ['init', '-q'])
  git(full, ['config', 'user.email', 'ios-script-test@example.com'])
  git(full, ['config', 'user.name', 'ios-script-test'])
  git(full, ['add', '-A'])
  git(full, ['commit', '-qm', 'init'])
  // A couple of extra commits so a shallow clone is observably shallower than `rev-list --count` on full history.
  for (const n of [2, 3, 4]) {
    writeFileSync(join(full, `rev-${n}.txt`), `${n}\n`)
    git(full, ['add', `rev-${n}.txt`])
    git(full, ['commit', '-qm', `c${n}`])
  }
  if (!shallow) return full
  const shallowDir = join(tmp, 'shallow')
  const clone = spawnSync('git', ['clone', '--depth', '1', `file://${full}`, shallowDir], { encoding: 'utf8' })
  assert.equal(clone.status, 0, `shallow clone failed: ${(clone.stderr || clone.stdout || '').slice(0, 400)}`)
  return shallowDir
}

function writeStubs(bin: string, rec: string) {
  const log = join(rec, 'commands.log')
  const envFile = join(rec, 'xcodebuild.env.json')
  const argsFile = join(rec, 'xcodebuild.args.txt')
  writeExec(
    join(bin, 'uname'),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "-s" ]]; then printf 'Darwin\\n'; exit 0; fi
if [[ -x /usr/bin/uname ]]; then exec /usr/bin/uname "$@"; fi
printf 'Darwin\\n'
`,
  )
  writeExec(
    join(bin, 'npx'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "npx cwd=$(pwd) args=$*" >> "${log}"
if [[ " $* " == *" prebuild "* ]]; then
  ios="\${HITLY_REPO_ROOT}/apps/mobile/ios"
  mkdir -p "\${ios}/HITLy.xcodeproj"
  : > "\${ios}/Podfile"
  # --no-install must not invent an .xcworkspace; a later pod install (or a
  # prebuild that is allowed to install) is what creates it.
  if [[ " $* " != *" --no-install "* ]]; then
    mkdir -p "\${ios}/HITLy.xcworkspace"
  fi
  exit 0
fi
if [[ " $* " == *" eas "* || " $* " == *" eas-cli@"* ]]; then
  mkdir -p "\${HITLY_REPO_ROOT}/apps/mobile/dist-ios"
  : > "\${HITLY_REPO_ROOT}/apps/mobile/dist-ios/device.ipa"
  : > "\${HITLY_REPO_ROOT}/apps/mobile/dist-ios/testflight.ipa"
  exit 0
fi
exit 0
`,
  )
  writeExec(
    join(bin, 'pod'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "pod cwd=$(pwd) args=$*" >> "${log}"
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' "\${HITLY_TEST_POD_VERSION:-1.16.2}"
  exit 0
fi
if [[ "\${1:-}" == "install" ]]; then
  mkdir -p "\${HITLY_REPO_ROOT}/apps/mobile/ios/HITLy.xcworkspace"
  exit 0
fi
exit 0
`,
  )
  writeExec(
    join(bin, 'xcodebuild'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "xcodebuild cwd=$(pwd) args=$*" >> "${log}"
python3 -c 'import json,os,sys; json.dump(dict(os.environ), open(sys.argv[1],"w"))' "${envFile}"
printf '%s\\n' "$@" > "${argsFile}"
out="\${HITLY_REPO_ROOT}/apps/mobile/dist-ios/simulator/derived/Build/Products/Debug-iphonesimulator/HITLy.app"
mkdir -p "\${out}"
printf '{\\n}' > "\${out}/Info.plist"
exit 0
`,
  )
  writeExec(
    join(bin, 'xcrun'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "xcrun cwd=$(pwd) args=$*" >> "${log}"
if [[ "\${1:-}" == "simctl" && "\${2:-}" == "list" ]]; then
  if [[ "\${HITLY_TEST_SIMCTL_EMPTY:-0}" == "1" ]]; then
    printf '%s\\n' '== Devices =='
    exit 0
  fi
  printf '%s\\n' '== Devices ==' 'iOS 18.6 -- iPhone 16 Pro (Booted)'
  exit 0
fi
if [[ "\${1:-}" == "PlistBuddy" || "\${1:-}" == "plutil" ]]; then
  exit 0
fi
exit 0
`,
  )
  writeExec(
    join(bin, 'PlistBuddy'),
    `#!/usr/bin/env bash
echo "PlistBuddy args=$*" >> "${log}"
exit 0
`,
  )
}

function runMocked(opts: MockOpts = {}): MockResult {
  assert.ok(existsSync(scriptPath), 'scripts/build-ios.sh missing')
  const tmp = mkdtempSync(join(tmpdir(), 'hitly194-'))
  const rec = join(tmp, 'rec')
  const bin = join(tmp, 'bin')
  mkdirSync(rec)
  mkdirSync(bin)
  writeStubs(bin, rec)
  const work = initWorktree(tmp, opts.shallow === true)
  const log = join(rec, 'commands.log')
  writeFileSync(log, '')
  const pathParts = [bin, process.env.PATH || '/usr/bin:/bin'].join(':')
  const env: Record<string, string> = {
    PATH: pathParts,
    HOME: tmp,
    TMPDIR: tmp,
    LANG: 'C',
    CI: '1',
    HITLY_REPO_ROOT: work,
    HITLY_ALLOW_DIRTY: '1',
    HITLY_TEST_POD_VERSION: opts.podVersion ?? '1.16.2',
  }
  if (opts.destination !== undefined) env.HITLY_IOS_DESTINATION = opts.destination
  if (opts.cc) env.CC = opts.cc
  if (opts.cxx) env.CXX = opts.cxx
  if (opts.ld) env.LD = opts.ld
  if (opts.developerDir) env.DEVELOPER_DIR = opts.developerDir
  if (opts.signingEnvContents !== undefined) {
    const envFile = join(tmp, 'signing.env')
    writeFileSync(envFile, opts.signingEnvContents)
    env.HITLY_IOS_SIGNING_ENV = envFile
  }
  Object.assign(env, opts.extraEnv ?? {})
  const result = spawnSync('bash', [scriptPath, opts.target ?? 'simulator'], {
    cwd: work,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  })
  let parsedEnv: Record<string, string> = {}
  const envFile = join(rec, 'xcodebuild.env.json')
  if (existsSync(envFile)) {
    try {
      parsedEnv = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>
    } catch {
      parsedEnv = {}
    }
  }
  const argsFile = join(rec, 'xcodebuild.args.txt')
  const args = existsSync(argsFile)
    ? readFileSync(argsFile, 'utf8').split(/\n/).filter((l) => l.length > 0)
    : []
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    out: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    log: existsSync(log) ? readFileSync(log, 'utf8') : '',
    args,
    env: parsedEnv,
    tmp,
  }
}

function cleanup(tmp: string) {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    // leave the scratch dir if a mid-run unlink races; tests must not print the path
  }
}

function xcodebuildInvoked(r: MockResult): boolean {
  return r.log.includes('xcodebuild ') || r.args.length > 0
}

function prebuildInvoked(r: MockResult): boolean {
  return /npx .*prebuild/.test(r.log)
}

// ---------------------------------------------------------------------------
// C1 F1 — pod install order
// ---------------------------------------------------------------------------

test('C1: pod install runs after prebuild --no-install and before xcodebuild, in apps/mobile/ios', () => {
  const r = runMocked({ podVersion: '1.16.2', cc: '/fake/clang' })
  try {
    assert.match(r.log, /npx .*prebuild/, 'expo prebuild was not invoked')
    const podLine = r.log.split(/\n/).find((l) => /^pod cwd=/.test(l) && /\binstall\b/.test(l))
    const preIdx = r.log.indexOf('npx ')
    const podIdx = r.log.search(/^pod cwd=.*\binstall\b/m)
    const xcIdx = r.log.search(/^xcodebuild /m)
    const droppedNoInstall = !/--no-install/.test(scriptText()) && prebuildInvoked(r)
    if (droppedNoInstall) {
      // Allowed alternative: drop --no-install so Expo's prebuild installs pods itself.
      // The npx stub creates the workspace only when --no-install is absent.
      assert.ok(xcodebuildInvoked(r), 'dropping --no-install is allowed only if the workspace then exists and xcodebuild runs')
      return
    }
    assert.ok(podLine, 'pod install was not invoked after prebuild (and --no-install is still present)')
    assert.match(podLine ?? '', /cwd=.*apps\/mobile\/ios/, 'pod install must run with cwd apps/mobile/ios')
    assert.ok(podIdx > preIdx, 'pod install must run after prebuild')
    assert.ok(xcIdx > podIdx && xcIdx >= 0, 'xcodebuild must run after pod install (the workspace check must not precede it)')
  } finally {
    cleanup(r.tmp)
  }
})

// ---------------------------------------------------------------------------
// C2 F2 — CocoaPods preflight
// ---------------------------------------------------------------------------

test('C2: CocoaPods 1.12 fails fast before prebuild and names the 1.13 minimum', () => {
  const r = runMocked({ podVersion: '1.12.0' })
  try {
    assert.notEqual(r.status, 0, 'pod 1.12.0 must fail the preflight')
    assert.match(r.out, /1\.13/, 'the error must name the 1.13 minimum')
    assert.match(r.out, /CocoaPods|pod/i)
    assert.equal(prebuildInvoked(r), false, 'prebuild must not run when CocoaPods is below 1.13')
    assert.equal(xcodebuildInvoked(r), false)
  } finally {
    cleanup(r.tmp)
  }
})

test('C2: CocoaPods 1.13.0 passes the preflight (prebuild may run)', () => {
  // Already-green pin on 78420089: there is no version gate, so 1.13 is not rejected.
  // After the gate exists this must stay green; a 1.14 threshold (M4) is killed here.
  const r = runMocked({ podVersion: '1.13.0' })
  try {
    assert.doesNotMatch(
      r.out,
      /(?:CocoaPods|pod).{0,80}(?:1\.14|too old|minimum is 1\.14|requires 1\.14)/i,
      '1.13.0 must not be rejected by the preflight (minimum is 1.13)',
    )
    const rejectedAsOld = r.status !== 0 && /1\.13/.test(r.out) && !prebuildInvoked(r) && /CocoaPods|pod/i.test(r.out)
    assert.equal(rejectedAsOld, false, '1.13.0 must pass the CocoaPods preflight')
  } finally {
    cleanup(r.tmp)
  }
})

test('C2: docs/ios-build.md states CocoaPods 1.13 minimum and 1.16.2 as verified', () => {
  const docs = docsText()
  assert.match(docs, /CocoaPods/i)
  assert.match(docs, /1\.13/)
  assert.match(docs, /1\.16\.2/)
})

// ---------------------------------------------------------------------------
// C3 F3 — toolchain env
// ---------------------------------------------------------------------------

test('C3: xcodebuild env does not inherit a fake CC/CXX/LD, and DEVELOPER_DIR is forwarded', () => {
  const r = runMocked({
    podVersion: '1.16.2',
    cc: '/fake/clang',
    cxx: '/fake/c++',
    ld: '/fake/ld',
    developerDir: '/fake/Xcode.app/Contents/Developer',
  })
  try {
    assert.ok(xcodebuildInvoked(r), 'xcodebuild was not invoked (C1 pod/workspace path may still be missing)')
    assert.ok(!('CC' in r.env) || r.env.CC === '', 'recorded xcodebuild env must not contain CC')
    assert.ok(!('CXX' in r.env) || r.env.CXX === '', 'recorded xcodebuild env must not contain CXX')
    assert.ok(!('LD' in r.env) || r.env.LD === '', 'recorded xcodebuild env must not contain LD')
    assert.equal(
      r.env.DEVELOPER_DIR,
      '/fake/Xcode.app/Contents/Developer',
      'DEVELOPER_DIR must be forwarded to xcodebuild',
    )
    // The fake values must not appear as the compiler either
    const blob = `${Object.entries(r.env).map(([k, v]) => `${k}=${v}`).join('\n')}\n${r.args.join(' ')}`
    assert.doesNotMatch(blob, /\/fake\/clang|\/fake\/c\+\+|\/fake\/ld/)
  } finally {
    cleanup(r.tmp)
  }
})

// ---------------------------------------------------------------------------
// C4 F4 — destination
// ---------------------------------------------------------------------------

test('C4: simulator xcodebuild receives -destination (default or HITLY_IOS_DESTINATION) and ONLY_ACTIVE_ARCH=YES', () => {
  const def = runMocked({ podVersion: '1.16.2' })
  try {
    assert.ok(xcodebuildInvoked(def), 'xcodebuild was not invoked (C1 pod/workspace path may still be missing)')
    const defJoined = def.args.join('\0')
    assert.match(defJoined, /^-destination$/m, 'default path must pass -destination')
    const destIdx = def.args.indexOf('-destination')
    assert.ok(destIdx >= 0 && def.args[destIdx + 1], 'default -destination must have a value')
    assert.match(def.args[destIdx + 1] ?? '', /iOS Simulator/, 'default destination must be an iOS Simulator')
    assert.ok(
      def.args.includes('ONLY_ACTIVE_ARCH=YES'),
      'xcodebuild must pass ONLY_ACTIVE_ARCH=YES',
    )
    const docs = docsText()
    assert.match(docs, /HITLY_IOS_DESTINATION/, 'docs must name the HITLY_IOS_DESTINATION override')
  } finally {
    cleanup(def.tmp)
  }

  const over = runMocked({
    podVersion: '1.16.2',
    destination: 'platform=iOS Simulator,name=iPhone 16 Pro',
  })
  try {
    assert.ok(xcodebuildInvoked(over), 'xcodebuild was not invoked for the override run')
    const idx = over.args.indexOf('-destination')
    assert.ok(idx >= 0, '-destination missing with HITLY_IOS_DESTINATION set')
    assert.equal(over.args[idx + 1], 'platform=iOS Simulator,name=iPhone 16 Pro')
    assert.ok(over.args.includes('ONLY_ACTIVE_ARCH=YES'))
  } finally {
    cleanup(over.tmp)
  }
})

test('C4: no matching simulator runtime fails fast without invoking xcodebuild', () => {
  const r = runMocked({
    podVersion: '1.16.2',
    destination: 'platform=iOS Simulator,name=NoSuchPhone',
    extraEnv: { HITLY_TEST_SIMCTL_EMPTY: '1' },
  })
  try {
    assert.notEqual(r.status, 0, 'a missing simulator runtime must fail the script')
    assert.match(r.out, /simulator|destination|runtime|NoSuchPhone/i)
    assert.equal(xcodebuildInvoked(r), false, 'xcodebuild must not run when no matching destination exists')
  } finally {
    cleanup(r.tmp)
  }
})

// ---------------------------------------------------------------------------
// C5 F5 — docs
// ---------------------------------------------------------------------------

test('C5: docs say the simulator .app is Debug, needs Metro (npx expo start), and unsigned keychain LogBox is expected', () => {
  const docs = docsText()
  assert.match(docs, /Debug/)
  assert.match(docs, /Metro/i)
  assert.match(docs, /npx expo start/)
  assert.match(docs, /keychain|LogBox|entitlement/i)
})

// ---------------------------------------------------------------------------
// C7 — signing-env order
// ---------------------------------------------------------------------------

test('C7: HITLY_IOS_SIGNING_ENV is sourced before the EXPO_TOKEN presence check', () => {
  // The token lives only in the env file (a placeholder, never a real token).
  const r = runMocked({
    target: 'device',
    signingEnvContents: 'EXPO_TOKEN=<test-placeholder>\n',
  })
  try {
    assert.doesNotMatch(
      r.out,
      /EXPO_TOKEN is not set/,
      'the credential gate must source HITLY_IOS_SIGNING_ENV before testing EXPO_TOKEN',
    )
    assert.match(
      r.log,
      /npx .*eas/,
      'after sourcing the signing env, the device target should reach the (stubbed) EAS invocation',
    )
  } finally {
    cleanup(r.tmp)
  }
})

// ---------------------------------------------------------------------------
// C8 — pin eas-cli
// ---------------------------------------------------------------------------

test('C8: device/testflight invoke a version-pinned eas-cli, not a bare npx eas', () => {
  const text = scriptText()
  assert.doesNotMatch(
    text,
    /npx\s+eas\s+build/,
    'do not call unpinned `npx eas build`; pin eas-cli to an exact version',
  )
  const pinnedInline = /npx\s+(?:--package\s+)?eas-cli@\d+\.\d+\.\d+/.test(text)
  const pinnedLocal = /node_modules\/\.bin\/eas\b/.test(text) || /\beas-cli@/.test(text)
  let inPackage = false
  for (const pkgPath of [join(mobileDir, 'package.json'), join(repoRoot, 'package.json')]) {
    if (!existsSync(pkgPath)) continue
    const pkg = readFileSync(pkgPath, 'utf8')
    if (/"eas-cli"\s*:\s*"\d+\.\d+\.\d+"/.test(pkg) || /"eas-cli"\s*:\s*"v?\d+\.\d+\.\d+"/.test(pkg)) {
      inPackage = true
    }
  }
  assert.ok(
    pinnedInline || (pinnedLocal && inPackage) || (pinnedLocal && /eas-cli@\d+\.\d+\.\d+/.test(text)),
    'eas-cli must be pinned to an exact x.y.z (npx eas-cli@x.y.z, or node_modules/.bin/eas with eas-cli in package.json)',
  )
  assert.match(docsText(), /eas-cli@\d+\.\d+\.\d+|eas-cli \d+\.\d+\.\d+|pinned eas-cli/i)
})

// ---------------------------------------------------------------------------
// C9 — autoIncrement dirty-tree docs (no EAS run required)
// ---------------------------------------------------------------------------

test('C9: docs describe EAS autoIncrement dirtying app.json and HITLY_ALLOW_DIRTY or a commit', () => {
  const docs = docsText()
  assert.match(docs, /autoIncrement/)
  assert.match(docs, /app\.json/)
  assert.match(docs, /HITLY_ALLOW_DIRTY|dirty/i)
  assert.match(docs, /commit/i)
})

// ---------------------------------------------------------------------------
// C10 — shallow clone
// ---------------------------------------------------------------------------

test('C10: a shallow clone warns or fails about CFBundleVersion unless HITLY_IOS_BUILD_NUMBER is set', () => {
  const text = scriptText()
  assert.match(text, /is-shallow-repository/, 'script must consult git rev-parse --is-shallow-repository')
  assert.match(text, /HITLY_IOS_BUILD_NUMBER/)
  assert.match(text, /shallow/)
  const r = runMocked({ podVersion: '1.16.2', shallow: true })
  try {
    if (xcodebuildInvoked(r) || /CFBundleVersion|build number|rev-list/i.test(r.out)) {
      const combined = r.out
      const overridden = runMocked({
        podVersion: '1.16.2',
        shallow: true,
        extraEnv: { HITLY_IOS_BUILD_NUMBER: '99' },
      })
      try {
        assert.match(combined, /shallow/i, 'when the build-number path runs on a shallow clone it must warn or fail')
        // An override may skip the warning; that is allowed. We only require the unset case to mention it.
        void overridden
      } finally {
        cleanup(overridden.tmp)
      }
    }
  } finally {
    cleanup(r.tmp)
  }
})
