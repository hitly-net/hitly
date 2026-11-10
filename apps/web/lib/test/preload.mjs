import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// Hooks must be registered before any @/lib module (and the fumadocs-mdx
// generated .source/server.ts) is imported: `await import('./preload.mjs')`
// first in tests.
register('./alias-resolve.mjs', import.meta.url)
register('fumadocs-mdx/node/loader', pathToFileURL(process.cwd() + '/'))
