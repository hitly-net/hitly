import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { EAS_PROJECT_ID, isAndroidReleaseBuild, resolveGoogleServicesFile } = require('../google-services.cjs') as {
  EAS_PROJECT_ID: string
  isAndroidReleaseBuild: (env?: Record<string, string | undefined>) => boolean
  resolveGoogleServicesFile: (env?: Record<string, string | undefined>) => string | undefined
}

test('EAS projectId is the metaspan/hitly Expo project', () => {
  assert.equal(EAS_PROJECT_ID, 'f6c17c55-3708-402c-8ced-95030bf1e5e5')
  const config = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app.config.js'), 'utf8')
  assert.match(config, /extra\.eas\.projectId|projectId: EAS_PROJECT_ID/)
  assert.match(config, /googleServicesFile/)
  assert.match(config, /GOOGLE_SERVICES_JSON|resolveGoogleServicesFile/)
})

test('dev builds may omit GOOGLE_SERVICES_JSON', () => {
  assert.equal(isAndroidReleaseBuild({}), false)
  assert.equal(isAndroidReleaseBuild({ EAS_BUILD_PROFILE: 'development' }), false)
  assert.equal(resolveGoogleServicesFile({}), undefined)
  assert.equal(
    resolveGoogleServicesFile({ GOOGLE_SERVICES_JSON: ' /tmp/google-services.json ' }),
    '/tmp/google-services.json',
  )
})

test('release builds fail clearly when GOOGLE_SERVICES_JSON is unset', () => {
  assert.equal(isAndroidReleaseBuild({ EAS_BUILD_PROFILE: 'production' }), true)
  assert.throws(
    () => resolveGoogleServicesFile({ EAS_BUILD_PROFILE: 'production' }),
    /GOOGLE_SERVICES_JSON must be set/,
  )
  assert.equal(
    resolveGoogleServicesFile({
      EAS_BUILD_PROFILE: 'production',
      GOOGLE_SERVICES_JSON: '/secrets/google-services.json',
    }),
    '/secrets/google-services.json',
  )
})
