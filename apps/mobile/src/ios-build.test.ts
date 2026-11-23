import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const srcDir = dirname(fileURLToPath(import.meta.url))
const mobileDir = join(srcDir, '..')
const repoRoot = join(mobileDir, '..', '..')

const appJsonPath = join(mobileDir, 'app.json')
const appConfigPath = join(mobileDir, 'app.config.js')
const easJsonPath = join(mobileDir, 'eas.json')
const scriptPath = join(repoRoot, 'scripts', 'build-ios.sh')
const docsPath = join(repoRoot, 'docs', 'ios-build.md')
const rootGitignorePath = join(repoRoot, '.gitignore')
const mobileGitignorePath = join(mobileDir, '.gitignore')

type EasIos = { simulator?: boolean }
type EasProfile = {
  developmentClient?: boolean
  distribution?: string
  credentialsSource?: string
  ios?: EasIos
}
type EasJson = {
  build?: Record<string, EasProfile | undefined>
}

type AppJson = {
  expo?: {
    version?: string
    plugins?: Array<string | [string, Record<string, unknown>?]>
    ios?: {
      bundleIdentifier?: string
      supportsTablet?: boolean
      associatedDomains?: string[]
      buildNumber?: string
      infoPlist?: Record<string, unknown>
    }
    android?: { package?: string }
    extra?: { eas?: { projectId?: string } }
  }
}

const { EAS_PROJECT_ID, isAndroidReleaseBuild, resolveGoogleServicesFile } = require('../google-services.cjs') as {
  EAS_PROJECT_ID: string
  isAndroidReleaseBuild: (env?: Record<string, string | undefined>) => boolean
  resolveGoogleServicesFile: (env?: Record<string, string | undefined>) => string | undefined
}

function readUtf8(path: string): string {
  assert.ok(existsSync(path), `missing required file: ${relative(repoRoot, path) || path}`)
  return readFileSync(path, 'utf8')
}

function loadAppJson(): AppJson {
  return JSON.parse(readUtf8(appJsonPath)) as AppJson
}

function loadEasJson(): EasJson {
  const raw = readUtf8(easJsonPath)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    assert.fail(`apps/mobile/eas.json is not valid JSON: ${(err as Error).message}`)
  }
  assert.equal(typeof parsed, 'object')
  assert.ok(parsed && !Array.isArray(parsed), 'apps/mobile/eas.json must be a JSON object')
  return parsed as EasJson
}

function combinedGitignore(): string {
  const parts: string[] = []
  if (existsSync(rootGitignorePath)) parts.push(readFileSync(rootGitignorePath, 'utf8'))
  if (existsSync(mobileGitignorePath)) parts.push(readFileSync(mobileGitignorePath, 'utf8'))
  return parts.join('\n')
}

/** True if a gitignore body has a pattern that ignores the given path (repo-root relative, POSIX). */
function gitignoreCovers(ignoreBody: string, repoRelativePosix: string, alsoCheckMobileFile: boolean): boolean {
  const lines = ignoreBody
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('!'))
  const candidates = new Set<string>([repoRelativePosix, repoRelativePosix.replace(/\/$/, '')])
  if (repoRelativePosix.startsWith('apps/mobile/')) {
    candidates.add(repoRelativePosix.slice('apps/mobile/'.length))
  }
  for (const line of lines) {
    const n = line.replace(/^\//, '').replace(/\/$/, '')
    if (candidates.has(n) || candidates.has(line) || candidates.has(line.replace(/^\//, ''))) return true
    // extension patterns like *.p8
    if (line.startsWith('*.') && repoRelativePosix.endsWith(line.slice(1))) return true
    if (n === repoRelativePosix || n === repoRelativePosix.replace(/\/$/, '')) return true
  }
  if (alsoCheckMobileFile && existsSync(mobileGitignorePath)) {
    const mobileBody = readFileSync(mobileGitignorePath, 'utf8')
    if (repoRelativePosix.startsWith('apps/mobile/')) {
      const local = repoRelativePosix.slice('apps/mobile/'.length)
      return gitignoreCovers(mobileBody, local, false) || gitignoreCovers(mobileBody, repoRelativePosix, false)
    }
  }
  return false
}

function pluginPresent(appJson: AppJson, name: string): boolean {
  const plugins = appJson.expo?.plugins ?? []
  return plugins.some((p) => p === name || (Array.isArray(p) && p[0] === name))
}

function scriptText(): string {
  return readUtf8(scriptPath)
}

const SECRET_ENV_NAMES = [
  'EXPO_TOKEN',
  'EXPO_APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APP_STORE_CONNECT_API_KEY_PATH',
  'ASC_API_KEY_PATH',
  'EXPO_ASC_API_KEY_PATH',
  'AUTHENTICATION_KEY_PATH',
  'HITLY_IOS_SIGNING_ENV',
  'HITLY_IOS_DIST_CERT',
  'HITLY_IOS_PROVISIONING_PROFILE',
  'HITLY_IOS_API_KEY_PATH',
]

function runScriptTarget(target: string, extraEnv: Record<string, string | undefined> = {}, timeoutMs = 20_000) {
  assert.ok(existsSync(scriptPath), 'scripts/build-ios.sh missing')
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: 'C',
    HITLY_REPO_ROOT: repoRoot,
    CI: '1',
  }
  for (const name of SECRET_ENV_NAMES) env[name] = undefined
  Object.assign(env, extraEnv)
  // spawnSync drops undefined values; explicitly unset by not including them
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) clean[k] = v
  }
  return spawnSync('bash', [scriptPath, target], {
    cwd: repoRoot,
    env: clean,
    encoding: 'utf8',
    timeout: timeoutMs,
  })
}

const PERMISSION_APIS: Array<{ id: string; patterns: RegExp; usageKey: string }> = [
  { id: 'camera', patterns: [/expo-camera/, /\bNSCameraUsageDescription\b/], usageKey: 'NSCameraUsageDescription' },
  {
    id: 'microphone',
    patterns: [/expo-av[^\n]*Audio/, /expo-audio/, /\bNSMicrophoneUsageDescription\b/],
    usageKey: 'NSMicrophoneUsageDescription',
  },
  {
    id: 'photo-library',
    patterns: [/expo-image-picker/, /expo-media-library/, /\bNSPhotoLibrary(UsageDescription|AddUsageDescription)\b/],
    usageKey: 'NSPhotoLibraryUsageDescription',
  },
  {
    id: 'location',
    patterns: [/expo-location/, /\bNSLocation(WhenInUse|AlwaysAndWhenInUse|Always)?UsageDescription\b/],
    usageKey: 'NSLocationWhenInUseUsageDescription',
  },
  {
    id: 'app-tracking',
    patterns: [/expo-tracking-transparency/, /AppTrackingTransparency/, /\bNSUserTrackingUsageDescription\b/],
    usageKey: 'NSUserTrackingUsageDescription',
  },
]

function walkTextFiles(dir: string, acc: string[] = [], depth = 0): string[] {
  if (depth > 8) return acc
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'coverage' || name === '.expo') continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walkTextFiles(full, acc, depth + 1)
    else if (st.isFile() && st.size < 1_000_000 && !/\.(png|jpg|jpeg|webp|gif|ttf|otf|woff2?|jar|apk|ipa|app|zip)$/i.test(name)) {
      acc.push(full)
    }
  }
  return acc
}

function looksLikeSecretLiteral(text: string, file: string): string | null {
  const rel = relative(repoRoot, file)
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return `${rel}: PEM private key block`
  // Real Expo push tokens, not the docs placeholder with an ellipsis
  if (/ExponentPushToken\[[A-Za-z0-9_-]{8,}\]/.test(text)) return `${rel}: ExponentPushToken literal`
  const expoTokenAssign = /(?:export\s+)?EXPO_TOKEN\s*=\s*['"]?([^\s'"]+)/
  const m = text.match(expoTokenAssign)
  if (m) {
    const value = m[1]
    const placeholder = /^(?:…|\.\.\.|<.*>|YOUR_.*|\$\{?EXPO_TOKEN\}?|TODO.*)?$/i.test(value)
    if (!placeholder && value.length >= 8) return `${rel}: EXPO_TOKEN assignment with a non-placeholder value`
  }
  return null
}

// ---------------------------------------------------------------------------
// C1–C3 eas.json
// ---------------------------------------------------------------------------

test('C1: apps/mobile/eas.json defines development-simulator, preview, and production profiles', () => {
  const eas = loadEasJson()
  assert.ok(eas.build && typeof eas.build === 'object', 'eas.json must have a "build" object')
  for (const name of ['development-simulator', 'preview', 'production'] as const) {
    assert.ok(eas.build[name], `eas.json build.${name} profile missing`)
    assert.equal(typeof eas.build[name], 'object')
  }
})

test('C2: development-simulator is a credential-free standalone simulator profile', () => {
  const profile = loadEasJson().build?.['development-simulator']
  assert.ok(profile, 'build.development-simulator missing')
  assert.equal(profile.ios?.simulator, true, 'development-simulator must set ios.simulator to true')
  assert.notEqual(profile.developmentClient, true, 'development-simulator must build the standalone reviewer app, not a dev client')
  assert.notEqual(profile.distribution, 'store', 'development-simulator must not be a store distribution')
})

test('C3: preview is internal/adhoc and production is store; both are standalone', () => {
  const eas = loadEasJson()
  const preview = eas.build?.preview
  const production = eas.build?.production
  assert.ok(preview, 'build.preview missing')
  assert.ok(production, 'build.production missing')
  assert.ok(
    preview.distribution === 'internal' || preview.distribution === 'adhoc',
    `preview.distribution must be "internal" or "adhoc", got ${String(preview.distribution)}`,
  )
  assert.equal(production.distribution, 'store', 'production.distribution must be "store"')
  assert.notEqual(preview.developmentClient, true, 'preview must not be a dev client')
  assert.notEqual(production.developmentClient, true, 'production must not be a dev client')
})

// ---------------------------------------------------------------------------
// C4–C6 script
// ---------------------------------------------------------------------------

test('C4: scripts/build-ios.sh exists, is bash, and implements simulator + unsigned paths', () => {
  const text = scriptText()
  assert.match(text, /^#!/ , 'scripts/build-ios.sh must start with a shebang')
  assert.match(text, /^#!\/usr\/bin\/env bash\b/m, 'shebang must be #!/usr/bin/env bash')
  assert.match(text, /\bsimulator\b/, 'script must implement a simulator target')
  assert.match(text, /\bunsigned\b/, 'script must implement an unsigned target')
  assert.match(text, /\bdevice\b/, 'script must implement a device target')
  assert.match(text, /\btestflight\b/, 'script must implement a testflight target')
  assert.match(text, /dist-ios/, 'script must write artifacts under dist-ios')
  assert.match(
    text,
    /expo prebuild[\s\S]*--platform ios|expo prebuild[\s\S]*-p ios|eas build[\s\S]*development-simulator/,
    'simulator/unsigned path must use expo prebuild -p ios and/or eas build --profile development-simulator',
  )
  assert.match(text, /--clean/, 'prebuild must be invoked with --clean for idempotency')
  assert.match(
    text,
    /git(?:\s+-C[^\n]*)?\s+checkout\s+--\s+apps\/mobile\/package\.json/,
    'script must restore apps/mobile/package.json after prebuild rewrites it (same as the Android script)',
  )
  assert.match(text, /HITLY_ALLOW_DIRTY/, 'script must honour HITLY_ALLOW_DIRTY=1 (and refuse a dirty tree otherwise)')
})

test('C5: device and testflight fail fast when credentials are unset, without printing secrets or prompting', () => {
  const text = scriptText()
  assert.doesNotMatch(text, /(?<![-\w])read(?:\s+-[-a-zA-Z]+)*\s+[A-Za-z_]/, 'script must not prompt with read')
  if (/\beas\b/.test(text)) {
    assert.match(text, /--non-interactive/, 'eas invocations must pass --non-interactive')
  }

  for (const target of ['device', 'testflight'] as const) {
    const result = runScriptTarget(target)
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    assert.notEqual(result.status, 0, `${target} must exit non-zero when signing credentials are unset (status=${result.status}, out=${out.slice(0, 500)})`)
    assert.match(
      out,
      /HITLY_IOS_SIGNING_ENV|EXPO_TOKEN|credential|signing|not set|missing/i,
      `${target} must name the missing credential input; output was: ${out.slice(0, 500)}`,
    )
    assert.doesNotMatch(out, /ExponentPushToken\[[A-Za-z0-9_-]{8,}\]/)
    assert.doesNotMatch(out, /-----BEGIN [A-Z ]*PRIVATE KEY-----/)
    assert.doesNotMatch(
      out,
      /yarn install|expo prebuild|xcodebuild|eas build/,
      `${target} must fail before yarn / prebuild / eas / xcodebuild; output was: ${out.slice(0, 800)}`,
    )
    assert.ok(
      result.error?.message?.includes('ETIMEDOUT') !== true && result.signal !== 'SIGTERM',
      `${target} must fail fast, not time out`,
    )
  }
})

test('C6: script uses set -euo pipefail and never enables xtrace or echoes secret env', () => {
  const text = scriptText()
  assert.match(text, /^\s*set -euo pipefail\s*$/m, 'script must contain set -euo pipefail')
  assert.doesNotMatch(text, /^\s*set\s+(-[a-zA-Z]*x[a-zA-Z]*|--xtrace)\b/m, 'script must not enable set -x / xtrace')
  assert.doesNotMatch(text, /bash\s+-x\b/, 'script must not invoke bash -x')
  assert.doesNotMatch(
    text,
    /(?:echo|printf)\s+[^\n]*\$(?:\{)?(?:EXPO_TOKEN|EXPO_APPLE_APP_SPECIFIC_PASSWORD|APPLE_APP_SPECIFIC_PASSWORD|HITLY_IOS_SIGNING_ENV)(?:\})?/,
    'script must not echo secret env vars or the signing-env path contents',
  )
})

test('C4-static: simulator and unsigned targets must not require credentials globally', () => {
  const text = scriptText()
  assert.match(text, /\bsimulator\b/)
  assert.match(text, /\bunsigned\b/)
  // A global, target-independent "EXPO_TOKEN must be set" (or equivalent) would break the
  // credential-free paths. Comments that mention the variable name are fine; a top-level
  // `die` / `exit` on those vars before the target is dispatched is not.
  const withoutComments = text
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
  const firstCaseOrTargetDispatch = withoutComments.search(
    /\b(case\s+"?\$[A-Z_]*"|simulator|unsigned|device|testflight)\b/,
  )
  const head = firstCaseOrTargetDispatch >= 0 ? withoutComments.slice(0, firstCaseOrTargetDispatch) : withoutComments
  const globalDie =
    /(?:\b(?:die|exit)\b[^\n]*(?:EXPO_TOKEN|HITLY_IOS_SIGNING_ENV)|\[\[\s+-z\s+"\$\{?(?:EXPO_TOKEN|HITLY_IOS_SIGNING_ENV))/.test(
      head,
    )
  assert.equal(
    globalDie,
    false,
    'simulator/unsigned must not require EXPO_TOKEN or HITLY_IOS_SIGNING_ENV before the target is selected',
  )
})

// ---------------------------------------------------------------------------
// C7, C8, C9, C12 identity / version / permissions
// ---------------------------------------------------------------------------

test('C7: existing iOS identity is preserved (bundle id, tablet, associated domains)', () => {
  const app = loadAppJson()
  assert.equal(app.expo?.ios?.bundleIdentifier, 'net.hitly.app')
  assert.equal(app.expo?.android?.package, 'net.hitly.app')
  assert.equal(app.expo?.ios?.supportsTablet, true)
  assert.ok(
    (app.expo?.ios?.associatedDomains ?? []).includes('applinks:cloud.hitly.net'),
    'expo.ios.associatedDomains must include applinks:cloud.hitly.net',
  )
  assert.ok(app.expo?.version && String(app.expo.version).length > 0, 'expo.version must remain the short-version source')
})

test('C8: iOS build number is monotonic (git rev-list or EAS autoIncrement), not a stuck "1"', () => {
  const app = loadAppJson()
  const buildNumber = app.expo?.ios?.buildNumber
  let easRaw = ''
  let script = ''
  if (existsSync(easJsonPath)) easRaw = readFileSync(easJsonPath, 'utf8')
  if (existsSync(scriptPath)) script = readFileSync(scriptPath, 'utf8')
  const hasGitCount = /git\s+rev-list\s+--count\s+HEAD/.test(script)
  const hasOverride = /HITLY_IOS_BUILD_NUMBER/.test(script)
  const hasAutoIncrement = /"autoIncrement"\s*:\s*true/.test(easRaw) || /\bautoIncrement\b/.test(easRaw)
  const hasMechanism = hasGitCount || hasAutoIncrement || (hasOverride && hasGitCount)
  assert.ok(
    hasMechanism,
    'need a monotonic build number: script default git rev-list --count HEAD (overridable via HITLY_IOS_BUILD_NUMBER) and/or EAS autoIncrement',
  )
  if (buildNumber !== undefined) {
    assert.notEqual(String(buildNumber), '1', 'a hard-coded expo.ios.buildNumber of "1" is not a monotonic mechanism on its own')
  }
  assert.ok(hasGitCount || hasAutoIncrement, 'local and/or EAS path must actually increment the build number')
})

test('C9: expo-notifications plugin remains; usage strings match APIs actually used', () => {
  const app = loadAppJson()
  assert.ok(pluginPresent(app, 'expo-notifications'), 'expo-notifications plugin must remain in app.json')
  const infoPlist = (app.expo?.ios?.infoPlist ?? {}) as Record<string, unknown>
  const background = infoPlist.UIBackgroundModes
  if (background !== undefined) {
    const modes = Array.isArray(background) ? background : [background]
    assert.ok(
      modes.map(String).includes('remote-notification'),
      'if UIBackgroundModes is set, it must include remote-notification',
    )
  }
  // If UIBackgroundModes is omitted, the expo-notifications plugin (asserted above) injects
  // remote-notification at prebuild. Prefer making it explicit; that is not a C9 fail.

  const sourceRoots = [join(mobileDir, 'src'), join(mobileDir, 'app'), join(mobileDir, 'package.json'), appJsonPath]
  const blobs: string[] = []
  for (const root of sourceRoots) {
    if (!existsSync(root)) continue
    const st = statSync(root)
    if (st.isFile()) blobs.push(readFileSync(root, 'utf8'))
    else {
      for (const f of walkTextFiles(root)) {
        if (/\.(tsx?|jsx?|json)$/.test(f)) blobs.push(readFileSync(f, 'utf8'))
      }
    }
  }
  const corpus = blobs.join('\n')
  const pkg = readUtf8(join(mobileDir, 'package.json'))
  for (const api of PERMISSION_APIS) {
    const used = api.patterns.some((re) => re.test(pkg) || re.test(corpus))
    if (!used) continue
    // Notification permission has no NS* usage string. The listed APIs do.
    if (api.id === 'camera' && !/expo-camera/.test(pkg) && !/expo-camera/.test(corpus)) continue
    const reallyUsed =
      (api.id === 'camera' && /from ['"]expo-camera['"]/.test(corpus)) ||
      (api.id === 'microphone' && /from ['"]expo-(av|audio)['"]/.test(corpus)) ||
      (api.id === 'photo-library' && /from ['"]expo-(image-picker|media-library)['"]/.test(corpus)) ||
      (api.id === 'location' && /from ['"]expo-location['"]/.test(corpus)) ||
      (api.id === 'app-tracking' && /from ['"]expo-tracking-transparency['"]/.test(corpus))
    if (!reallyUsed) continue
    assert.ok(
      typeof infoPlist[api.usageKey] === 'string' && String(infoPlist[api.usageKey]).trim().length > 0,
      `app uses ${api.id} but expo.ios.infoPlist.${api.usageKey} is missing`,
    )
  }
})

test('C12: EAS project id is unchanged and still injected via app.config.js', () => {
  assert.equal(EAS_PROJECT_ID, 'f6c17c55-3708-402c-8ced-95030bf1e5e5')
  const config = readUtf8(appConfigPath)
  assert.match(config, /projectId:\s*EAS_PROJECT_ID|extra\.eas\.projectId/)
  if (existsSync(easJsonPath)) {
    const easRaw = readFileSync(easJsonPath, 'utf8')
    const foreign = easRaw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []
    for (const id of foreign) {
      assert.equal(id.toLowerCase(), EAS_PROJECT_ID, `eas.json must not override the Expo project id (found ${id})`)
    }
  }
})

// ---------------------------------------------------------------------------
// C10 docs, C11 gitignore + secrets, C16 google-services footgun
// ---------------------------------------------------------------------------

test('C10: docs/ios-build.md covers simulator, unsigned, signed device, TestFlight, and Apple prerequisites', () => {
  const docs = readUtf8(docsPath)
  assert.match(docs, /simulator/i, 'docs must cover the simulator path')
  assert.match(docs, /unsigned|ad-?hoc/i, 'docs must cover the local unsigned / ad-hoc-style path')
  assert.match(docs, /TestFlight/i, 'docs must cover the TestFlight path')
  assert.match(docs, /credential|signing/i, 'docs must describe the credential-gated signed path')
  assert.match(docs, /Xcode/i, 'docs must name the Xcode toolchain')
  assert.match(docs, /Yarn|yarn/i, 'docs must name Yarn')
  assert.match(docs, /dist-ios/, 'docs must name the output directory')
  assert.match(docs, /Apple Developer|App Store Connect|ASC|provisioning/i, 'docs must list Apple prerequisites by name')
  assert.match(docs, /no Apple credential|without.*credential|no EXPO_TOKEN|without them/i)
  assert.doesNotMatch(docs, /ExponentPushToken\[[A-Za-z0-9_-]{8,}\]/)
  assert.doesNotMatch(docs, /-----BEGIN [A-Z ]*PRIVATE KEY-----/)
  assert.doesNotMatch(docs, /(?:export\s+)?EXPO_TOKEN\s*=\s*['"]?[A-Za-z0-9._-]{12,}/)

  const readme = existsSync(join(mobileDir, 'README.md')) ? readFileSync(join(mobileDir, 'README.md'), 'utf8') : ''
  const mobileDoc = existsSync(join(repoRoot, 'docs', 'mobile.md')) ? readFileSync(join(repoRoot, 'docs', 'mobile.md'), 'utf8') : ''
  assert.ok(
    /docs\/ios-build\.md/.test(readme) || /docs\/ios-build\.md/.test(mobileDoc),
    'docs/mobile.md and/or apps/mobile/README.md must link to docs/ios-build.md',
  )
})

test('C11: .gitignore covers iOS signing artifacts and generated trees', () => {
  const body = combinedGitignore()
  assert.ok(body.length > 0, '.gitignore missing')
  const checks: Array<[string, string]> = [
    ['*.p8', 'dummy.p8'],
    ['*.p12', 'dummy.p12'],
    ['*.mobileprovision', 'dummy.mobileprovision'],
    ['credentials.json', 'credentials.json'],
    ['apps/mobile/ios/', 'apps/mobile/ios/'],
    ['apps/mobile/dist-ios/', 'apps/mobile/dist-ios/'],
  ]
  for (const [label, rel] of checks) {
    assert.ok(
      gitignoreCovers(body, rel, true) || gitignoreCovers(body, label, true),
      `.gitignore must cover ${label}`,
    )
  }
})

test('C11: no secret literals committed in mobile config, scripts, or ios-build docs', () => {
  const files = [
    appJsonPath,
    appConfigPath,
    join(mobileDir, 'google-services.cjs'),
    docsPath,
    easJsonPath,
    scriptPath,
    join(repoRoot, 'docs', 'mobile.md'),
    fileURLToPath(import.meta.url),
  ].filter((p) => existsSync(p))
  // Also scan scripts/ and docs/ shallowly for accidental key material
  for (const dir of [join(repoRoot, 'scripts'), join(repoRoot, 'docs')]) {
    if (existsSync(dir)) files.push(...walkTextFiles(dir))
  }
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file)) continue
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    const hit = looksLikeSecretLiteral(text, file)
    assert.equal(hit, null, hit ?? undefined)
  }
})

test('C16: iOS-only / development-simulator EAS builds must not require GOOGLE_SERVICES_JSON', () => {
  assert.equal(
    isAndroidReleaseBuild({ EAS_BUILD: 'true', EAS_BUILD_PROFILE: 'development-simulator' }),
    false,
    'development-simulator must not be treated as an Android release (EAS_BUILD=true)',
  )
  assert.equal(
    isAndroidReleaseBuild({
      EAS_BUILD: 'true',
      EAS_BUILD_PLATFORM: 'ios',
      EAS_BUILD_PROFILE: 'production',
    }),
    false,
    'iOS production must not be treated as an Android release',
  )
  assert.equal(
    isAndroidReleaseBuild({
      EAS_BUILD: 'true',
      EAS_BUILD_PLATFORM: 'ios',
      EAS_BUILD_PROFILE: 'preview',
    }),
    false,
    'iOS preview must not be treated as an Android release',
  )
  assert.doesNotThrow(() =>
    resolveGoogleServicesFile({
      EAS_BUILD: 'true',
      EAS_BUILD_PROFILE: 'development-simulator',
    }),
  )
  assert.doesNotThrow(() =>
    resolveGoogleServicesFile({
      EAS_BUILD: 'true',
      EAS_BUILD_PLATFORM: 'ios',
      EAS_BUILD_PROFILE: 'production',
    }),
  )
  // Android production must still require the file when the platform is android.
  assert.equal(
    isAndroidReleaseBuild({
      EAS_BUILD: 'true',
      EAS_BUILD_PLATFORM: 'android',
      EAS_BUILD_PROFILE: 'production',
    }),
    true,
  )
  assert.throws(
    () =>
      resolveGoogleServicesFile({
        EAS_BUILD: 'true',
        EAS_BUILD_PLATFORM: 'android',
        EAS_BUILD_PROFILE: 'production',
      }),
    /GOOGLE_SERVICES_JSON must be set/,
  )
})

// ---------------------------------------------------------------------------
// SHOULD (recorded, not ACCEPT-blocking)
// ---------------------------------------------------------------------------

test('C13 SHOULD: architecture doc points at the in-repo iOS build path', () => {
  // SHOULD only — logs a miss, does not fail the suite / CI.
  const path = join(repoRoot, 'docs', 'architecture', 'mobile-app.md')
  if (!existsSync(path)) {
    console.warn('SHOULD miss: C13 docs/architecture/mobile-app.md missing')
    return
  }
  const body = readFileSync(path, 'utf8')
  const linked = /docs\/ios-build\.md/.test(body) && /scripts\/build-ios\.sh/.test(body)
  const stale = /Release\/signing pipeline details live in EAS \(external\), not in this repo/.test(body)
  if (!linked || stale) {
    console.warn(
      'SHOULD miss: C13 architecture doc should link to docs/ios-build.md and scripts/build-ios.sh and drop the “pipeline lives only in external EAS” wording',
    )
  }
})

test('C14 SHOULD: export-compliance key is set, or the docs tell the submitter to answer it', () => {
  // SHOULD only — logs a miss, does not fail the suite / CI.
  const app = loadAppJson()
  const flag = app.expo?.ios?.infoPlist?.ITSAppUsesNonExemptEncryption
  const docs = existsSync(docsPath) ? readFileSync(docsPath, 'utf8') : ''
  const documented = /ITSAppUsesNonExemptEncryption|export compliance|export-compliance/i.test(docs)
  if (!(flag === true || flag === false || documented)) {
    console.warn(
      'SHOULD miss: C14 set expo.ios.infoPlist.ITSAppUsesNonExemptEncryption or document the TestFlight export-compliance question',
    )
  }
})

test('C15 SHOULD: a credential-free macOS CI job for the simulator target is optional', () => {
  // Recorded only. Absence is not an ACCEPT failure; Hermes lists SHOULD misses separately.
  const workflowsDir = join(repoRoot, '.github', 'workflows')
  let body = ''
  if (existsSync(workflowsDir)) {
    for (const name of readdirSync(workflowsDir)) {
      if (name.endsWith('.yml') || name.endsWith('.yaml')) {
        body += `\n${readFileSync(join(workflowsDir, name), 'utf8')}`
      }
    }
  }
  const hasMacosIos =
    /macos-/.test(body) && /build-ios|development-simulator|iphonesimulator|xcodebuild/i.test(body)
  if (!hasMacosIos) {
    // Soft assertion: the test still passes, but the name documents the SHOULD gap.
    assert.ok(true, 'no macOS iOS simulator CI job (SHOULD only; #139 also omitted CI)')
  } else {
    assert.ok(hasMacosIos)
  }
})

// Silence unused import in some tsconfigs; isAbsolute is used as a sanity check on paths
test('harness: tests are running from the monorepo mobile package', () => {
  assert.ok(isAbsolute(repoRoot))
  assert.equal(repoRoot.split(sep).slice(-1)[0] === 'mobile', false)
  assert.ok(existsSync(join(mobileDir, 'package.json')))
  assert.ok(existsSync(appJsonPath))
})
