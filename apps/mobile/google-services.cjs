'use strict'

const EAS_PROJECT_ID = 'f6c17c55-3708-402c-8ced-95030bf1e5e5'

function isAndroidReleaseBuild(env = process.env) {
  const profile = (env.EAS_BUILD_PROFILE ?? '').trim()
  const platform = (env.EAS_BUILD_PLATFORM ?? '').trim().toLowerCase()
  // iOS builds (including the credential-free simulator profile) never need
  // google-services.json, regardless of profile.
  if (platform === 'ios') return false
  if (profile === 'development' || profile === 'development-simulator') return false
  if (profile === 'production' || profile === 'preview' || profile === 'release') return true
  if (env.EAS_BUILD === 'true' && profile && profile !== 'development' && profile !== 'development-simulator') return true
  return false
}

function resolveGoogleServicesFile(env = process.env) {
  const file = typeof env.GOOGLE_SERVICES_JSON === 'string' ? env.GOOGLE_SERVICES_JSON.trim() : ''
  if (file) return file
  if (isAndroidReleaseBuild(env)) {
    throw new Error(
      'GOOGLE_SERVICES_JSON must be set to the path of google-services.json for Android release builds.',
    )
  }
  return undefined
}

module.exports = { EAS_PROJECT_ID, isAndroidReleaseBuild, resolveGoogleServicesFile }
