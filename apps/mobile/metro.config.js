const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')
const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
config.resolver.disableHierarchicalLookup = true

// @hitly/core keeps a Node-only fallback (`await import('node:crypto')`) behind a
// WebCrypto check. React Native has no Node builtins, so release bundling fails
// to resolve it. Resolve Node builtins to an empty module for the app bundle;
// the mobile app never calls those code paths.
const upstreamResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('node:')) return { type: 'empty' }
  if (upstreamResolveRequest) return upstreamResolveRequest(context, moduleName, platform)
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
