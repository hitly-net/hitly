import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// scripts/build-android-apk.sh drives expo prebuild + gradle, neither of which
// exists in CI or on most laptops. Same pattern as ios-build-script.test.ts:
// run the real script against a throwaway repo whose toolchain is stub
// binaries, and assert what it did — including the #205 launcher-resource
// gate that refuses an APK without the brand's launcher artwork.

const srcDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(srcDir, '..', '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'build-android-apk.sh')
const docsPath = join(repoRoot, 'docs', 'android-apk-build.md')

const GOOD_CERT = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233'

const BASE_ENTRIES = [
  'AndroidManifest.xml',
  'classes.dex',
  'res/mipmap-anydpi-v26/ic_launcher.xml',
  'res/mipmap-anydpi-v26/ic_launcher_round.xml',
  'res/mipmap-hdpi/ic_launcher.png',
  'res/mipmap-xxhdpi/ic_launcher.png',
  'res/mipmap-xxhdpi/ic_launcher_round.png',
  'res/drawable-hdpi/ic_launcher_foreground.png',
  'res/drawable-xxhdpi/ic_launcher_foreground.png',
  'res/drawable-xxhdpi/ic_launcher_monochrome.png',
]

function writeExec(path: string, body: string) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { encoding: 'utf8', mode: 0o755 })
  chmodSync(path, 0o755)
}

function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').slice(0, 400)}`)
}

/** Fake checkout with just enough shape for the script's git/node steps. */
function initRepo(tmp: string): string {
  const repo = join(tmp, 'repo')
  mkdirSync(join(repo, 'apps', 'mobile'), { recursive: true })
  writeFileSync(
    join(repo, 'apps', 'mobile', 'package.json'),
    `${JSON.stringify({ name: '@hitly/mobile', private: true, version: '0.0.2' }, null, 2)}\n`,
  )
  writeFileSync(
    join(repo, 'apps', 'mobile', 'app.json'),
    `${JSON.stringify({ expo: { name: 'HITLy', slug: 'hitly', version: '0.0.2' } }, null, 2)}\n`,
  )
  writeFileSync(join(repo, '.gitignore'), 'apps/mobile/android/\napps/mobile/dist-android/\n')
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'android-script-test@example.com'])
  git(repo, ['config', 'user.name', 'android-script-test'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])
  return repo
}

/** `expo prebuild` stand-in: generate the android/ tree gradle expects. */
function writeStubs(bin: string, rec: string) {
  const log = join(rec, 'commands.log')
  writeExec(
    join(bin, 'yarn'),
    `echo "yarn $*" >> "${log}"`,
  )
  writeExec(
    join(bin, 'npx'),
    `echo "npx $*" >> "${log}"
if [[ " $* " == *" prebuild "* ]]; then
  android="\${HITLY_REPO_ROOT}/apps/mobile/android"
  mkdir -p "\${android}/app"
  cat > "\${android}/app/build.gradle" <<'GRADLE'
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
        }
    }
    defaultConfig {
        versionCode 1
        versionName "0.0.2"
    }
}
GRADLE
  : > "\${android}/gradle.properties"
  cat > "\${android}/gradlew" <<'GRADLEW'
#!/usr/bin/env bash
set -euo pipefail
echo "gradlew $*" >> "${log}"
mkdir -p app/build/outputs/apk/release
printf 'PK\\x03\\x04fake-apk' > app/build/outputs/apk/release/app-release.apk
GRADLEW
  chmod +x "\${android}/gradlew"
fi`,
  )
  // unzip -Z1 lists the APK entries the test asked for.
  writeExec(join(bin, 'unzip'), `cat "${'${HITLY_TEST_APK_LIST}'}"`)
  // apksigner is resolved via $ANDROID_HOME/build-tools/*/apksigner, not PATH.
  const sdk = join(rec, 'sdk', 'build-tools', '36.0.0')
  mkdirSync(sdk, { recursive: true })
  writeExec(
    join(sdk, 'apksigner'),
    `echo "apksigner $*" >> "${log}"
if [[ " $* " == *"--print-certs"* ]]; then
  echo "Signer #1 certificate SHA-256 digest: ${GOOD_CERT}"
fi`,
  )
}

type RunResult = { status: number | null; stdout: string; stderr: string; log: string; apkDir: string }

function runScript(tmp: string, entries: string[], extraEnv: Record<string, string> = {}): RunResult {
  const repo = initRepo(tmp)
  const bin = join(tmp, 'bin')
  const rec = join(tmp, 'rec')
  const outDir = join(tmp, 'out')
  mkdirSync(bin, { recursive: true })
  mkdirSync(rec, { recursive: true })
  mkdirSync(join(tmp, 'java'), { recursive: true })
  writeStubs(bin, rec)

  const keystore = join(tmp, 'release.jks')
  writeFileSync(keystore, 'not-a-real-keystore')
  const apkList = join(tmp, 'apk-entries.txt')
  writeFileSync(apkList, `${entries.join('\n')}\n`)

  const r = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HITLY_REPO_ROOT: repo,
      HITLY_ANDROID_SIGNING_ENV: '',
      GOOGLE_SERVICES_JSON: '',
      JAVA_HOME: join(tmp, 'java'),
      ANDROID_HOME: join(rec, 'sdk'),
      HITLY_ANDROID_KEYSTORE_FILE: keystore,
      HITLY_ANDROID_KEYSTORE_PASSWORD: 'test-keystore-password',
      HITLY_ANDROID_KEY_ALIAS: 'hitly-release',
      HITLY_ANDROID_KEY_PASSWORD: 'test-key-password',
      HITLY_ANDROID_OUT_DIR: outDir,
      HITLY_ANDROID_VERSION_CODE: '4242',
      HITLY_ANDROID_EXPECTED_CERT_SHA256: GOOD_CERT.toUpperCase().replace(/(.{2})(?!$)/g, '$1:'),
      HITLY_TEST_APK_LIST: apkList,
      ...extraEnv,
    },
  })
  const log = existsSync(join(rec, 'commands.log')) ? readFileSync(join(rec, 'commands.log'), 'utf8') : ''
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log, apkDir: outDir }
}

test('build script exists and is documented', () => {
  assert.ok(existsSync(scriptPath), 'scripts/build-android-apk.sh missing')
  const docs = readFileSync(docsPath, 'utf8')
  assert.match(docs, /scripts\/build-android-apk\.sh/)
  assert.match(docs, /Launcher-resource gate/i)
  assert.match(docs, /ic_launcher_foreground/)
  assert.match(docs, /ic_launcher_monochrome/)
})

test('happy path: prebuild --clean, assembleRelease, verified APK with launcher resources', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hitly-android-build-'))
  const r = runScript(tmp, GOOD_APK_ENTRIES())
  assert.equal(r.status, 0, `script failed: ${r.stderr.slice(0, 600)}`)
  assert.match(r.log, /npx expo prebuild --platform android --no-install --clean/)
  assert.match(r.log, /gradlew --no-daemon assembleRelease/)
  assert.match(r.log, /apksigner verify/)
  const produced = readdirNames(r.apkDir)
  assert.deepEqual(produced.filter((n) => /^hitly-0\.0\.2-[0-9a-f]{8}\.apk$/.test(n)), produced,
    `unexpected output dir contents: ${produced.join(', ')}`)
  assert.match(r.stdout, /launcher:.*ic_launcher mipmaps \+ adaptive layers verified/)
  // Signing material must never reach build output.
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /test-keystore-password|test-key-password/)
})

test('gate fails when the APK carries no launcher bitmaps', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hitly-android-build-'))
  const r = runScript(tmp, GOOD_APK_ENTRIES().filter((e) => !/mipmap-.*\/ic_launcher.*\.png$/.test(e)))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no launcher bitmaps/)
})

test('gate fails when the adaptive icon XML is missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hitly-android-build-'))
  const r = runScript(tmp, GOOD_APK_ENTRIES().filter((e) => e !== 'res/mipmap-anydpi-v26/ic_launcher.xml'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no adaptive icon/)
})

test('gate fails when the adaptive foreground layer is missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hitly-android-build-'))
  const r = runScript(tmp, GOOD_APK_ENTRIES().filter((e) => !/ic_launcher_foreground\.png$/.test(e)))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no adaptive foreground layer/)
})

test('gate fails when the themed monochrome layer is missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hitly-android-build-'))
  const r = runScript(tmp, GOOD_APK_ENTRIES().filter((e) => !/ic_launcher_monochrome\.png$/.test(e)))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no themed monochrome layer/)
})

test('gate fails when the signer does not match the expected cert', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hitly-android-build-'))
  const r = runScript(tmp, GOOD_APK_ENTRIES(), {
    HITLY_ANDROID_EXPECTED_CERT_SHA256: 'ff'.repeat(32),
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /does not match HITLY_ANDROID_EXPECTED_CERT_SHA256/)
})

function GOOD_APK_ENTRIES(): string[] {
  return [...BASE_ENTRIES]
}

function readdirNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}
