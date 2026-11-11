const { EAS_PROJECT_ID, resolveGoogleServicesFile } = require('./google-services.cjs')

module.exports = ({ config }) => {
  const googleServicesFile = resolveGoogleServicesFile()
  return {
    ...config,
    extra: {
      ...(config.extra ?? {}),
      eas: {
        ...((config.extra && config.extra.eas) || {}),
        projectId: EAS_PROJECT_ID,
      },
    },
    android: {
      ...(config.android ?? {}),
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  }
}
