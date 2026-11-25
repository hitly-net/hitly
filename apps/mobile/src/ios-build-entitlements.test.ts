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

// hitly#194 F6 entitlement delta, REV2 (25 Nov 2026).
// Rev1 required keychain-access-groups via `codesign -d --entitlements`. The real-Mac rerun at
// cf185ea5 showed that cannot pass on Xcode 16.4 for an ad-hoc iphonesimulator build: codesign prints
// no entitlements, they live in the Mach-O __TEXT,__entitlements section, and the keychain default
// access group comes from application-identifier. Rev2 replaces C13 and C16, and adds C18
// (CFBundleVersion). C11, C12, C14, C15 are carried over unchanged.
// Do not edit apps/mobile/src/ios-build.test.ts or apps/mobile/src/ios-build-script.test.ts.

const srcDir = dirname(fileURLToPath(import.meta.url))
const mobileDir = join(srcDir, '..')
const repoRoot = join(mobileDir, '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'build-ios.sh')
const docsPath = join(repoRoot, 'docs', 'ios-build.md')

function plist(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}</dict>
</plist>
`
}

const appId = (value: string) => `  <key>application-identifier</key>\n  <string>${value}</string>\n`
const KAG = (value: string) => `  <key>keychain-access-groups</key>\n  <array>\n    <string>${value}</string>\n  </array>\n`

// What a real Xcode 16.4 ad-hoc iphonesimulator build carries in __TEXT,__entitlements (no keychain-access-groups).
const REAL_SECTION = plist(
  `${appId('FAKETEAMID.net.hitly.app')}  <key>aps-environment</key>\n  <string>development</string>\n  <key>com.apple.developer.associated-domains</key>\n  <array>\n    <string>applinks:cloud.hitly.net</string>\n  </array>\n`,
)
// What `codesign -d --entitlements -` prints on that same build: nothing useful.
const EMPTY_CODESIGN = ''
const NO_APP_ID_SECTION = plist(`  <key>aps-environment</key>\n  <string>development</string>\n`)

type MockOpts = {
  target?: string
  // Text the codesign stub prints for `-d --entitlements`.
  codesignEntitlements?: string
  // Text the segedit stub writes for `-extract __TEXT __entitlements`; undefined => the section is unavailable (segedit fails).
  sectionEntitlements?: string
  buildNumber?: string
  extraEnv?: Record<string, string>
}

type MockResult = {
  status: number | null
  out: string
  log: string
  args: string[]
  env: Record<string, string>
  tmp: string
  work: string
  shippedApp: string
  shippedPlist: string | null
  segeditBinary: string | null
  loggedBuild: string | null
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

function initWorktree(tmp: string): string {
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
  git(full, ['config', 'user.email', 'ios-entitlements-test@example.com'])
  git(full, ['config', 'user.name', 'ios-entitlements-test'])
  git(full, ['add', '-A'])
  git(full, ['commit', '-qm', 'init'])
  for (const n of [2, 3, 4]) {
    writeFileSync(join(full, `rev-${n}.txt`), `${n}\n`)
    git(full, ['add', `rev-${n}.txt`])
    git(full, ['commit', '-qm', `c${n}`])
  }
  return full
}

function writeStubs(bin: string, rec: string) {
  const log = join(rec, 'commands.log')
  const envFile = join(rec, 'xcodebuild.env.json')
  const argsFile = join(rec, 'xcodebuild.args.txt')
  const codesignArgs = join(rec, 'codesign.args.txt')
  const segeditBin = join(rec, 'segedit.binary.txt')
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
  // xcodebuild leaves a .app whose Info.plist still has CFBundleVersion=1 (the Xcode default) and a main executable.
  writeExec(
    join(bin, 'xcodebuild'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "xcodebuild cwd=$(pwd) args=$*" >> "${log}"
python3 -c 'import json,os,sys; json.dump(dict(os.environ), open(sys.argv[1],"w"))' "${envFile}"
printf '%s\\n' "$@" > "${argsFile}"
derived=""
config="Debug"
sdk="iphonesimulator"
prev=""
for a in "$@"; do
  if [[ "$prev" == "-derivedDataPath" ]]; then derived="$a"; fi
  if [[ "$prev" == "-configuration" ]]; then config="$a"; fi
  if [[ "$prev" == "-sdk" ]]; then sdk="$a"; fi
  prev="$a"
done
if [[ -z "$derived" ]]; then
  derived="\${HITLY_REPO_ROOT}/apps/mobile/dist-ios/simulator/derived"
fi
out="$derived/Build/Products/\${config}-\${sdk}/HITLy.app"
mkdir -p "$out"
printf 'CFBundleVersion=1\\n' > "$out/Info.plist"
printf 'MACHO-STUB\\n' > "$out/HITLy"
chmod +x "$out/HITLy"
exit 0
`,
  )
  writeExec(
    join(bin, 'xcrun'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "xcrun cwd=$(pwd) args=$*" >> "${log}"
if [[ "\${1:-}" == "simctl" && "\${2:-}" == "list" ]]; then
  printf '%s\\n' '== Devices ==' 'iOS 18.6 -- iPhone 16 Pro (Booted)'
  exit 0
fi
case "\${1:-}" in
  codesign|segedit|PlistBuddy|plutil)
    tool="$1"; shift
    exec "$tool" "$@"
    ;;
esac
exit 0
`,
  )
  // Real codesign prints NOTHING useful for an ad-hoc iphonesimulator build on Xcode 16.4 (HITLY_TEST_CODESIGN_ENTITLEMENTS unset/empty).
  writeExec(
    join(bin, 'codesign'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "codesign cwd=$(pwd) args=$*" >> "${log}"
printf '%s\\n' "$@" >> "${codesignArgs}"
printf '%s' "\${HITLY_TEST_CODESIGN_ENTITLEMENTS:-}"
exit 0
`,
  )
  // segedit <input> -extract <seg> <sect> <file>
  writeExec(
    join(bin, 'segedit'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "segedit cwd=$(pwd) args=$*" >> "${log}"
input="\${1:-}"
printf '%s\\n' "$input" >> "${segeditBin}"
if [[ "\${2:-}" != "-extract" || "\${3:-}" != "__TEXT" || "\${4:-}" != "__entitlements" || -z "\${5:-}" ]]; then
  echo "segedit stub: unexpected args: $*" >&2
  exit 2
fi
if [[ "\${HITLY_TEST_SEGEDIT_FAIL:-0}" == "1" ]]; then
  echo "segedit stub: section __TEXT,__entitlements not found" >&2
  exit 1
fi
printf '%s' "\${HITLY_TEST_SEGEDIT_ENTITLEMENTS:-}" > "$5"
exit 0
`,
  )
  // PlistBuddy stub with real Set/Add semantics on a "KEY=value" file, so the stamped value is observable.
  writeExec(
    join(bin, 'PlistBuddy'),
    `#!/usr/bin/env bash
echo "PlistBuddy args=$*" >> "${log}"
cmd="\${2:-}"
file="\${3:-}"
if [[ "$cmd" =~ ^(Set|Add)\\ :CFBundleVersion\\ (string\\ )?(.+)$ ]]; then
  v="\${BASH_REMATCH[3]}"
  { grep -v '^CFBundleVersion=' "$file" 2>/dev/null || true; printf 'CFBundleVersion=%s\\n' "$v"; } > "$file.tmp"
  mv "$file.tmp" "$file"
fi
exit 0
`,
  )
}

function runMocked(opts: MockOpts = {}): MockResult {
  assert.ok(existsSync(scriptPath), 'scripts/build-ios.sh missing')
  const tmp = mkdtempSync(join(tmpdir(), 'hitly194-f6r2-'))
  const rec = join(tmp, 'rec')
  const bin = join(tmp, 'bin')
  mkdirSync(rec)
  mkdirSync(bin)
  writeStubs(bin, rec)
  const work = initWorktree(tmp)
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
    HITLY_TEST_POD_VERSION: '1.16.2',
    HITLY_TEST_CODESIGN_ENTITLEMENTS: opts.codesignEntitlements ?? EMPTY_CODESIGN,
  }
  if (opts.sectionEntitlements === undefined) env.HITLY_TEST_SEGEDIT_FAIL = '1'
  else env.HITLY_TEST_SEGEDIT_ENTITLEMENTS = opts.sectionEntitlements
  if (opts.buildNumber) env.HITLY_IOS_BUILD_NUMBER = opts.buildNumber
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
  const args = existsSync(argsFile) ? readFileSync(argsFile, 'utf8').split(/\n/).filter((l) => l.length > 0) : []
  const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const shippedApp = join(work, 'apps', 'mobile', 'dist-ios', 'simulator', 'HITLy.app')
  const shippedPlistPath = join(shippedApp, 'Info.plist')
  const segeditFile = join(rec, 'segedit.binary.txt')
  const built = /\(build (\d+)[,)]/.exec(out)
  return {
    status: result.status,
    out,
    log: existsSync(log) ? readFileSync(log, 'utf8') : '',
    args,
    env: parsedEnv,
    tmp,
    work,
    shippedApp,
    shippedPlist: existsSync(shippedPlistPath) ? readFileSync(shippedPlistPath, 'utf8') : null,
    segeditBinary: existsSync(segeditFile) ? readFileSync(segeditFile, 'utf8').split('\n')[0] : null,
    loggedBuild: built ? built[1] : null,
  }
}

function cleanup(tmp: string) {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

function xcodebuildInvoked(r: MockResult): boolean {
  return r.args.length > 0 || /\bxcodebuild\b/.test(r.log)
}

function lastAllowed(args: string[]): string | undefined {
  const hits = args.filter((a) => a.startsWith('CODE_SIGNING_ALLOWED='))
  return hits.length > 0 ? hits[hits.length - 1] : undefined
}

function hasAdHocIdentity(args: string[]): boolean {
  return args.some((a) => /^CODE_SIGN_IDENTITY=-$/.test(a) || a === 'CODE_SIGN_IDENTITY="-"')
}

function plistBuildNumber(r: MockResult): string | null {
  if (r.shippedPlist === null) return null
  const m = /^CFBundleVersion=(.*)$/m.exec(r.shippedPlist)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Carried over unchanged from rev1: C11, C12, C14, C15
// ---------------------------------------------------------------------------

test('C11: simulator xcodebuild does not pass CODE_SIGNING_ALLOWED=NO and ad-hoc signs with CODE_SIGN_IDENTITY=-', () => {
  const r = runMocked({ sectionEntitlements: REAL_SECTION })
  try {
    assert.equal(xcodebuildInvoked(r), true, 'simulator target must reach xcodebuild')
    assert.equal(
      r.args.includes('CODE_SIGNING_ALLOWED=NO'),
      false,
      `simulator xcodebuild must not pass CODE_SIGNING_ALLOWED=NO (argv=${JSON.stringify(r.args)})`,
    )
    assert.ok(
      hasAdHocIdentity(r.args),
      `simulator xcodebuild must pass CODE_SIGN_IDENTITY=- so entitlements embed (argv=${JSON.stringify(r.args)})`,
    )
    const allowed = lastAllowed(r.args)
    if (allowed !== undefined) {
      assert.equal(allowed, 'CODE_SIGNING_ALLOWED=YES', `last CODE_SIGNING_ALLOWED on argv must not disable signing (got ${allowed})`)
    }
  } finally {
    cleanup(r.tmp)
  }
})

test('C12: leftover env CODE_SIGNING_ALLOWED=NO must not win over simulator ad-hoc argv (order)', () => {
  const r = runMocked({
    sectionEntitlements: REAL_SECTION,
    extraEnv: { CODE_SIGNING_ALLOWED: 'NO', CODE_SIGN_IDENTITY: '' },
  })
  try {
    assert.equal(xcodebuildInvoked(r), true, 'simulator target must reach xcodebuild')
    assert.ok(hasAdHocIdentity(r.args), 'CODE_SIGN_IDENTITY=- must be on the xcodebuild argv so it wins over a leftover env')
    assert.equal(
      r.args.includes('CODE_SIGNING_ALLOWED=NO'),
      false,
      'a leftover CODE_SIGNING_ALLOWED=NO in the environment must not appear on the simulator argv',
    )
    assert.notEqual(lastAllowed(r.args), 'CODE_SIGNING_ALLOWED=NO', 'last CODE_SIGNING_ALLOWED on argv must not be NO')
  } finally {
    cleanup(r.tmp)
  }
})

test('C12b: the xcodebuild child environment does not carry a leftover CODE_SIGNING_ALLOWED / CODE_SIGN_IDENTITY (M-E3 env form)', () => {
  const r = runMocked({
    sectionEntitlements: REAL_SECTION,
    extraEnv: { CODE_SIGNING_ALLOWED: 'NO', CODE_SIGN_IDENTITY: 'Some Identity', CC: '/nonexistent/cc', CXX: '/nonexistent/cxx', LD: '/nonexistent/ld' },
  })
  try {
    assert.equal(xcodebuildInvoked(r), true, 'simulator target must reach xcodebuild')
    assert.notEqual(r.env.CODE_SIGNING_ALLOWED, 'NO', 'xcodebuild must not inherit CODE_SIGNING_ALLOWED=NO from the caller environment')
    assert.equal(r.env.CODE_SIGNING_ALLOWED, undefined, 'xcodebuild must not inherit any CODE_SIGNING_ALLOWED from the caller environment')
    assert.equal(r.env.CODE_SIGN_IDENTITY, undefined, 'xcodebuild must not inherit CODE_SIGN_IDENTITY from the caller environment')
    for (const k of ['CC', 'CXX', 'LD']) assert.equal(r.env[k], undefined, `xcodebuild must not inherit ${k}`)
  } finally {
    cleanup(r.tmp)
  }
})

test('C14: unsigned target still passes CODE_SIGNING_ALLOWED=NO and does not require a team', () => {
  const r = runMocked({ target: 'unsigned' })
  try {
    assert.equal(xcodebuildInvoked(r), true, 'unsigned target must reach xcodebuild')
    assert.ok(
      r.args.includes('CODE_SIGNING_ALLOWED=NO'),
      `unsigned (iphoneos) path must stay signing-disabled (argv=${JSON.stringify(r.args)})`,
    )
    assert.equal(
      r.args.some((a) => /^DEVELOPMENT_TEAM=.+$/.test(a)),
      false,
      'unsigned must not newly require a DEVELOPMENT_TEAM',
    )
    assert.doesNotMatch(r.out, /Apple (ID|account|team)|EXPO_TOKEN is not set/i)
  } finally {
    cleanup(r.tmp)
  }
})

test('C15: simulator target does not require DEVELOPMENT_TEAM or Apple credentials', () => {
  const r = runMocked({ sectionEntitlements: REAL_SECTION })
  try {
    assert.equal(xcodebuildInvoked(r), true, 'simulator must reach xcodebuild with no Apple team or account set')
    assert.equal(
      r.args.some((a) => /^DEVELOPMENT_TEAM=.+$/.test(a)),
      false,
      'simulator argv must not require DEVELOPMENT_TEAM',
    )
    assert.doesNotMatch(r.out, /DEVELOPMENT_TEAM is not set|Apple (ID|account) is not set|EXPO_TOKEN is not set/i)
    assert.equal(Object.prototype.hasOwnProperty.call(r.env, 'EXPO_TOKEN') && r.env.EXPO_TOKEN !== '', false)
  } finally {
    cleanup(r.tmp)
  }
})

// ---------------------------------------------------------------------------
// C13 (rev2): entitlement verification reads codesign OR the __TEXT,__entitlements section and
// requires application-identifier ending in .net.hitly.app. keychain-access-groups is NOT required.
// ---------------------------------------------------------------------------

test('C13a: real Xcode 16 shape (codesign prints nothing; section has application-identifier, no keychain-access-groups) passes', () => {
  const r = runMocked({ codesignEntitlements: EMPTY_CODESIGN, sectionEntitlements: REAL_SECTION })
  try {
    assert.equal(
      r.status,
      0,
      `simulator run must exit 0 on the real Xcode 16 shape (status=${r.status}, out=${r.out.slice(0, 600)})`,
    )
    assert.match(r.log, /\bsegedit\b/, 'when codesign prints nothing the script must read the __TEXT,__entitlements section with segedit')
    assert.match(
      r.segeditBinary ?? '',
      /dist-ios\/simulator\/HITLy\.app\/HITLy$/,
      `the section must be read from the main executable of the SHIPPED dist-ios/simulator .app, not derived/ (got ${r.segeditBinary})`,
    )
    assert.doesNotMatch(r.out, /keychain-access-groups/i, 'the script must not demand or complain about keychain-access-groups')
  } finally {
    cleanup(r.tmp)
  }
})

test('C13b: codesign output with application-identifier passes even when the section is unavailable', () => {
  const r = runMocked({
    codesignEntitlements: plist(appId('FAKETEAMID.net.hitly.app')),
    sectionEntitlements: undefined,
  })
  try {
    assert.equal(r.status, 0, `status=${r.status}, out=${r.out.slice(0, 600)}`)
    assert.match(r.log, /\bcodesign\b[^\n]*-d/, 'codesign -d --entitlements must be consulted')
  } finally {
    cleanup(r.tmp)
  }
})

test('C13c: no application-identifier from either source fails fast and names application-identifier', () => {
  const r = runMocked({ codesignEntitlements: EMPTY_CODESIGN, sectionEntitlements: NO_APP_ID_SECTION })
  try {
    assert.notEqual(r.status, 0, 'a simulator .app with no application-identifier must fail the script')
    assert.match(r.out, /application-identifier/, 'the error must name application-identifier')
    assert.match(r.out, /entitlement/i)
  } finally {
    cleanup(r.tmp)
  }
})

test('C13d: keychain-access-groups alone is not enough (no application-identifier) and the error names application-identifier', () => {
  const r = runMocked({
    codesignEntitlements: plist(KAG('FAKETEAMID.net.hitly.app')),
    sectionEntitlements: undefined,
  })
  try {
    assert.notEqual(r.status, 0, 'keychain-access-groups without application-identifier must not pass the gate')
    assert.match(r.out, /application-identifier/)
  } finally {
    cleanup(r.tmp)
  }
})

test('C13e: application-identifier must be <non-empty team prefix>.net.hitly.app (empty, wrong bundle, wrong shape all fail)', () => {
  const bad: Array<[string, string]> = [
    ['wrong bundle id', 'FAKETEAMID.com.example.other'],
    ['empty team prefix', '.net.hitly.app'],
    ['empty value', ''],
    ['no dot separator', 'FAKETEAMIDnet.hitly.app'],
    ['suffix after bundle id', 'FAKETEAMID.net.hitly.app.extra'],
  ]
  for (const [label, value] of bad) {
    const r = runMocked({ codesignEntitlements: EMPTY_CODESIGN, sectionEntitlements: plist(appId(value)) })
    try {
      assert.notEqual(r.status, 0, `${label}: application-identifier "${value}" must fail`)
      assert.match(r.out, /application-identifier/, `${label}: the error must name application-identifier`)
    } finally {
      cleanup(r.tmp)
    }
  }
  // keychain-access-groups must not rescue a wrong application-identifier.
  const rescued = runMocked({
    codesignEntitlements: EMPTY_CODESIGN,
    sectionEntitlements: plist(`${appId('FAKETEAMID.com.example.other')}${KAG('FAKETEAMID.com.example.other')}`),
  })
  try {
    assert.notEqual(rescued.status, 0, 'a keychain-access-groups entry must not rescue a wrong application-identifier')
  } finally {
    cleanup(rescued.tmp)
  }
})

test('C13f: a real team prefix (not only FAKETEAMID) is accepted', () => {
  const r = runMocked({ codesignEntitlements: EMPTY_CODESIGN, sectionEntitlements: plist(appId('ABCDE12345.net.hitly.app')) })
  try {
    assert.equal(r.status, 0, `status=${r.status}, out=${r.out.slice(0, 600)}`)
  } finally {
    cleanup(r.tmp)
  }
})

// ---------------------------------------------------------------------------
// C18: the shipped .app's CFBundleVersion equals the build number the log prints.
// The stub PlistBuddy applies Set/Add :CFBundleVersion to a KEY=value Info.plist stub, which xcodebuild
// leaves at CFBundleVersion=1 (as Xcode does). Linux harness only: macOS has the real PlistBuddy.
// ---------------------------------------------------------------------------

const onMac = process.platform === 'darwin'

test('C18a: shipped CFBundleVersion equals the logged build number (HITLY_IOS_BUILD_NUMBER override)', { skip: onMac }, () => {
  const r = runMocked({ sectionEntitlements: REAL_SECTION, buildNumber: '167' })
  try {
    assert.equal(r.status, 0, `status=${r.status}, out=${r.out.slice(0, 600)}`)
    assert.equal(r.loggedBuild, '167', `the script log must print the build number (out=${r.out.slice(0, 400)})`)
    assert.equal(plistBuildNumber(r), '167', `shipped Info.plist CFBundleVersion must equal the logged build (plist=${JSON.stringify(r.shippedPlist)})`)
  } finally {
    cleanup(r.tmp)
  }
})

test('C18b: shipped CFBundleVersion equals the logged build number (git rev-list default)', { skip: onMac }, () => {
  const r = runMocked({ sectionEntitlements: REAL_SECTION })
  try {
    assert.equal(r.status, 0, `status=${r.status}, out=${r.out.slice(0, 600)}`)
    assert.match(r.loggedBuild ?? '', /^\d+$/, 'the script log must print a numeric build number')
    assert.notEqual(plistBuildNumber(r), '1', 'CFBundleVersion must not be left at the Xcode default 1')
    assert.equal(plistBuildNumber(r), r.loggedBuild)
  } finally {
    cleanup(r.tmp)
  }
})

test('C18c (pin): the stamp is not regressed when the gate passes through codesign output', { skip: onMac }, () => {
  const r = runMocked({
    codesignEntitlements: plist(`${appId('FAKETEAMID.net.hitly.app')}${KAG('FAKETEAMID.net.hitly.app')}`),
    sectionEntitlements: undefined,
    buildNumber: '171',
  })
  try {
    assert.equal(r.status, 0, `status=${r.status}, out=${r.out.slice(0, 600)}`)
    assert.equal(plistBuildNumber(r), '171')
  } finally {
    cleanup(r.tmp)
  }
})

test('C18d: when the entitlement gate fails, no shipped .app is left with a CFBundleVersion that disagrees with the log', { skip: onMac }, () => {
  const r = runMocked({ codesignEntitlements: EMPTY_CODESIGN, sectionEntitlements: NO_APP_ID_SECTION, buildNumber: '168' })
  try {
    assert.notEqual(r.status, 0, 'the gate must fail')
    assert.equal(r.loggedBuild, '168')
    if (existsSync(r.shippedApp)) {
      assert.equal(
        plistBuildNumber(r),
        '168',
        `a left-behind shipped .app must carry the logged build number, not the Xcode default (plist=${JSON.stringify(r.shippedPlist)}); stamp before the gate or remove the artifact on failure`,
      )
    }
  } finally {
    cleanup(r.tmp)
  }
})

// ---------------------------------------------------------------------------
// C16 (rev2): docs
// ---------------------------------------------------------------------------

test('C16: docs describe ad-hoc simulator signing, the real entitlement source, application-identifier, and no Apple team', () => {
  const docs = docsText()
  assert.match(docs, /CODE_SIGN_IDENTITY|ad-hoc|adhoc/i)
  assert.match(docs, /application-identifier/)
  assert.match(docs, /__TEXT,\s*__entitlements|__entitlements/)
  assert.match(docs, /segedit/)
  assert.match(docs, /codesign[\s\S]{0,240}(empty|nothing|no output|no entitlements)/i, 'docs must say codesign -d --entitlements shows nothing on the simulator')
  assert.match(
    docs,
    /keychain-access-groups[\s\S]{0,240}not (required|needed)|not (required|needed)[\s\S]{0,240}keychain-access-groups/i,
    'docs must say keychain-access-groups is not required',
  )
  assert.match(docs, /Debug/)
  assert.match(docs, /Metro/i)
  assert.match(docs, /npx expo start/)
  assert.match(docs, /no Apple (team|account|ID|credentials)|does not need an Apple|credential-free/i)
  // The rev1 / cf185ea5 wording that is now wrong.
  assert.doesNotMatch(docs, /dump must contain `?keychain-access-groups/i)
  assert.doesNotMatch(docs, /must show that key/i)
  assert.doesNotMatch(docs, /missing keychain entitlement/i)
  assert.doesNotMatch(docs, /Those LogBox messages are expected/i)
  assert.doesNotMatch(docs, /Unsigned Debug builds also surface keychain and\s+entitlement errors in LogBox/i)
})
