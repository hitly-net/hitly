const ROOT = new URL('../../', import.meta.url)
const ALIAS = 'https://hitly.local/__alias__/'

/**
 * Minimal "@/" → repo-root resolver for running tests with plain node:
 * tsx applies tsconfig paths but forces CJS output for .ts, which cannot
 * load fumadocs-mdx's generated .source/server.ts (top-level await).
 */
export async function resolve(specifier, context, nextResolve) {
  let spec = specifier
  if (spec.startsWith('@/')) spec = ALIAS + spec.slice(2)
  if (spec.startsWith(ALIAS)) {
    const rel = spec.slice(ALIAS.length)
    for (const cand of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`]) {
      const url = new URL(cand, ROOT)
      if (url.protocol === 'file:') {
        const { existsSync } = await import('node:fs')
        if (existsSync(url)) return { url: url.href, shortCircuit: true }
      }
    }
    throw new Error(`Cannot resolve alias specifier: ${specifier}`)
  }
  return nextResolve(spec, context)
}
