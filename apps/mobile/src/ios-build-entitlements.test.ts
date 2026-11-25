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

// hitly#194 F6 entitlement delta. New file only.
// Do not edit apps/mobile/src/ios-build.test.ts or ios-build-script.test.ts.

const srcDir = dirname(fileURLToPath(import.meta.url))
const mobileDir = join(srcDir, '..')
const repoRoot = join(mobileDir, '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'build-ios.sh')
const docsPath = join(repoRoot, 'docs', 'ios-build.md')

const DEFAULT_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>keychain-access-groups</key>
  <array>
    <string>$(AppIdentifierPrefix)net.hitly.app</string>
  </array>
</dict>
</plist>
`

const EMPTY_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>
`

type MockOpts = {
  target?: string
  codesignEntitlements?: string
  extraEnv?: Record<string, string>
}

type MockResult = {
  status: number | null
  out: string
  log: string
  args: string[]
  env: Record<string, string>
  tmp: string
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
  return full
}

function writeStubs(bin: string, rec: string) {
  const log = join(rec, 'commands.log')
  const envFile = join(rec, 'xcodebuild.env.json')
  const argsFile = join(rec, 'xcodebuild.args.txt')
  const codesignArgs = join(rec, 'codesign.args.txt')
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
printf '{\\n}' > "$out/Info.plist"
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
if [[ "\${1:-}" == "codesign" ]]; then
  shift
  echo "codesign cwd=$(pwd) args=$*" >> "${log}"
  printf '%s\\n' "$@" > "${codesignArgs}"
  printf '%s' "\${HITLY_TEST_CODESIGN_ENTITLEMENTS:-}"
  exit 0
fi
if [[ "\${1:-}" == "PlistBuddy" || "\${1:-}" == "plutil" ]]; then
  exit 0
fi
exit 0
`,
  )
  writeExec(
    join(bin, 'codesign'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "codesign cwd=$(pwd) args=$*" >> "${log}"
printf '%s\\n' "$@" > "${codesignArgs}"
printf '%s' "\${HITLY_TEST_CODESIGN_ENTITLEMENTS:-}"
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
  const tmp = mkdtempSync(join(tmpdir(), 'hitly194-f6-'))
  const rec = join(tmp, 'rec')
  const bin = join(tmp, 'bin')
  mkdirSync(rec)
  mkdirSync(bin)
  writeStubs(bin, rec)
  const work = initWorktree(tmp)
  const log = join(rec, 'commands.log')
  writeFileSync(log, '')
  const pathParts = [bin, process.env.PATH || '/usr/bin:/bin'].join(':')
  const entitlements = opts.codesignEntitlements ?? DEFAULT_ENTITLEMENTS
  const env: Record<string, string> = {
    PATH: pathParts,
    HOME: tmp,
    TMPDIR: tmp,
    LANG: 'C',
    CI: '1',
    HITLY_REPO_ROOT: work,
    HITLY_ALLOW_DIRTY: '1',
    HITLY_TEST_POD_VERSION: '1.16.2',
    HITLY_TEST_CODESIGN_ENTITLEMENTS: entitlements,
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

function codesignInspectedShippedSimulatorApp(r: MockResult): boolean {
  const lines = r.log.split(/\n/).filter((l) => /\bcodesign\b/.test(l))
  return lines.some((l) => /dist-ios\/simulator\/[^/\s]+\.app/.test(l) && !/\/derived\//.test(l))
}

function codesignDumpFlagsPresent(r: MockResult): boolean {
  const rec = join(r.tmp, 'rec', 'codesign.args.txt')
  const fromFile = existsSync(rec) ? readFileSync(rec, 'utf8') : ''
  const hay = `${r.log}\n${fromFile}`
  return /\s-d(\s|$)/.test(` ${hay} `) && /--entitlements/.test(hay)
}

test('C11: simulator xcodebuild does not pass CODE_SIGNING_ALLOWED=NO and ad-hoc signs with CODE_SIGN_IDENTITY=-', () => {
  const r = runMocked()
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
  const r = runMocked({ extraEnv: { CODE_SIGNING_ALLOWED: 'NO', CODE_SIGN_IDENTITY: '' } })
  try {
    assert.equal(xcodebuildInvoked(r), true, 'simulator target must reach xcodebuild')
    assert.ok(
      hasAdHocIdentity(r.args),
      'CODE_SIGN_IDENTITY=- must be on the xcodebuild argv so it wins over a leftover env',
    )
    assert.equal(
      r.args.includes('CODE_SIGNING_ALLOWED=NO'),
      false,
      'a leftover CODE_SIGNING_ALLOWED=NO in the environment must not appear on the simulator argv',
    )
    const allowed = lastAllowed(r.args)
    assert.notEqual(allowed, 'CODE_SIGNING_ALLOWED=NO', 'last CODE_SIGNING_ALLOWED on argv must not be NO')
  } finally {
    cleanup(r.tmp)
  }
})

test('C13: simulator path runs codesign --entitlements on the shipped dist-ios .app and exits 0 when keychain-access-groups is present', () => {
  const r = runMocked({ codesignEntitlements: DEFAULT_ENTITLEMENTS })
  try {
    assert.ok(
      /\bcodesign\b/.test(r.log),
      'the official simulator path must invoke codesign after the build to verify entitlements',
    )
    assert.ok(
      codesignDumpFlagsPresent(r),
      'codesign must be invoked with -d and --entitlements',
    )
    assert.ok(
      codesignInspectedShippedSimulatorApp(r),
      'codesign must inspect the shipped apps/mobile/dist-ios/simulator/*.app, not only a derived-data path',
    )
    assert.equal(r.status, 0, `simulator run must exit 0 when keychain-access-groups is present (status=${r.status}, out=${r.out.slice(0, 500)})`)
  } finally {
    cleanup(r.tmp)
  }
})

test('C13: simulator path fails fast when codesign entitlements lack keychain-access-groups', () => {
  const r = runMocked({ codesignEntitlements: EMPTY_ENTITLEMENTS })
  try {
    assert.ok(
      /\bcodesign\b/.test(r.log),
      'the script must consult codesign entitlements (or xcrun codesign) before deciding the simulator .app is usable',
    )
    assert.notEqual(r.status, 0, 'a simulator .app missing keychain-access-groups must fail the script')
    assert.match(
      r.out,
      /keychain-access-groups|entitlement/i,
      'the error must name the missing entitlement',
    )
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
      r.args.some((a) => /^DEVELOPMENT_TEAM=.+$/.test(a) && !/^DEVELOPMENT_TEAM=$/.test(a)),
      false,
      'unsigned must not newly require a DEVELOPMENT_TEAM',
    )
    assert.doesNotMatch(r.out, /Apple (ID|account|team)|EXPO_TOKEN is not set/i)
  } finally {
    cleanup(r.tmp)
  }
})

test('C15: simulator target does not require DEVELOPMENT_TEAM or Apple credentials', () => {
  const r = runMocked()
  try {
    assert.equal(xcodebuildInvoked(r), true, 'simulator must reach xcodebuild with no Apple team or account set')
    assert.equal(
      r.args.some((a) => /^DEVELOPMENT_TEAM=.+$/.test(a) && !/^DEVELOPMENT_TEAM=$/.test(a)),
      false,
      'simulator argv must not require DEVELOPMENT_TEAM',
    )
    assert.doesNotMatch(
      r.out,
      /DEVELOPMENT_TEAM is not set|Apple (ID|account) is not set|EXPO_TOKEN is not set/i,
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(r.env, 'EXPO_TOKEN') && r.env.EXPO_TOKEN !== undefined && r.env.EXPO_TOKEN !== '',
      false,
    )
  } finally {
    cleanup(r.tmp)
  }
})

test('C16: docs describe ad-hoc simulator signing, the entitlements check, no Apple team, and must not treat official-sim entitlement errors as expected', () => {
  const docs = docsText()
  assert.match(docs, /CODE_SIGN_IDENTITY|ad-hoc|adhoc/i)
  assert.match(docs, /keychain-access-groups/)
  assert.match(docs, /codesign/)
  assert.match(docs, /Metro/i)
  assert.match(docs, /npx expo start/)
  assert.match(
    docs,
    /no Apple (team|account|ID|credentials)|Apple (team|account|ID).{0,80}(not required|no .*required)|does not need an Apple|credential-free/i,
  )
  assert.doesNotMatch(
    docs,
    /Those LogBox messages are expected|entitlement errors in LogBox\. Those LogBox messages are expected|are expected: there is no\s+signing identity/i,
  )
  assert.doesNotMatch(
    docs,
    /Unsigned Debug builds also surface keychain and\s+entitlement errors in LogBox/i,
  )
})
