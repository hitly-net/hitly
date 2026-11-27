/**
 * CLI: put the connection cards on the built Factory SPA's Settings →
 * Connections screen (hitly-net/hitly#218), or take them back out.
 *
 *   tsx scripts/patch-factory-ui.ts [--index <path> | --dist <dir>] [--check] [--revert] [--force]
 *
 * The patch is a single marker-delimited `<script>` tag appended to the built
 * SPA `index.html`, loading the plugin's own `/boot.js` route. It is applied
 * only to the pinned `@mastra/factory` version; anything else is a clean skip
 * with a warning and an untouched file, so a Factory upgrade can never leave a
 * half-applied patch behind. Set `HITLY_FACTORY_UI_PATCH=0` to disable it
 * entirely, and delete the marker block (or run `--revert`) once upstream
 * ships the real Connections extension point (hitly-net/hitly#211).
 *
 * Exits 0 on success and on every clean skip. `--check` exits 1 when the file
 * is not in the expected state, so deploys can gate on it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import {
  applyFactoryUiPatch,
  checkFactoryUiPatch,
  checkFactoryUiVersion,
  isFactoryUiPatchEnabled,
  revertFactoryUiPatch,
  FACTORY_UI_PATCH_ENV,
  PINNED_FACTORY_UI_VERSION,
} from '../src/patch-factory-ui.ts'

const TAG = '[patch-factory-ui]'

function log(message: string): void {
  console.log(`${TAG} ${message}`)
}

function warn(message: string): void {
  console.warn(`${TAG} WARNING: ${message}`)
}

interface Args {
  index?: string
  dist?: string
  factoryVersion?: string
  check: boolean
  revert: boolean
  force: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { check: false, revert: false, force: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (!value) throw new Error(`${arg} needs a value`)
      i += 1
      return value
    }
    if (arg === '--index') args.index = next()
    else if (arg === '--dist') args.dist = next()
    else if (arg === '--factory-version') args.factoryVersion = next()
    else if (arg === '--check') args.check = true
    else if (arg === '--revert') args.revert = true
    else if (arg === '--force') args.force = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

/**
 * Find the built SPA index.html. Same candidate order Factory uses to resolve
 * its UI dist (MASTRACODE_UI_DIST, ./factory, src/mastra/public/factory).
 */
function resolveIndexPath(args: Args): { path: string } | { missing: string[] } {
  const tried: string[] = []
  const candidates: string[] = []
  if (args.index) candidates.push(isAbsolute(args.index) ? args.index : resolve(process.cwd(), args.index))
  if (args.dist) candidates.push(join(isAbsolute(args.dist) ? args.dist : resolve(process.cwd(), args.dist), 'index.html'))
  const envDist = process.env.MASTRACODE_UI_DIST
  if (envDist) candidates.push(join(isAbsolute(envDist) ? envDist : resolve(process.cwd(), envDist), 'index.html'))
  candidates.push(resolve(process.cwd(), 'factory/index.html'))
  candidates.push(resolve(process.cwd(), 'src/mastra/public/factory/index.html'))
  for (const candidate of candidates) {
    tried.push(candidate)
    if (existsSync(candidate)) return { path: candidate }
  }
  return { missing: tried.length ? tried : ['(no candidate — pass --index or --dist)'] }
}

function installedFactoryVersion(): string | null {
  const require = createRequire(import.meta.url)
  for (const from of [join(process.cwd(), 'noop.js'), import.meta.url]) {
    try {
      const pkgPath = require.resolve('@mastra/factory/package.json', { paths: [dirname(from)] })
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
      if (pkg.version) return pkg.version
    } catch {
      // try the next resolution root
    }
  }
  return null
}

function main(argv: string[]): number {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error))
    return 2
  }
  if (args.help) {
    log(`usage: tsx scripts/patch-factory-ui.ts [--index <path> | --dist <dir>] [--factory-version <v>] [--check] [--revert] [--force]`)
    log(`pinned @mastra/factory version: ${PINNED_FACTORY_UI_VERSION}; off-switch: ${FACTORY_UI_PATCH_ENV}=0`)
    return 0
  }

  if (!isFactoryUiPatchEnabled()) {
    log(`${FACTORY_UI_PATCH_ENV} disables the Factory Connections patch — nothing to do`)
    return 0
  }

  const target = resolveIndexPath(args)
  if ('missing' in target) {
    warn(`no built Factory SPA index.html found (looked at: ${target.missing.join(', ')}) — skipping the patch, Factory UI left untouched`)
    return 0
  }

  const factoryVersion = args.factoryVersion ?? installedFactoryVersion()
  if (!args.revert && !args.force) {
    const version = checkFactoryUiVersion(factoryVersion)
    if (!version.ok) {
      warn(`${version.reason} — skipping the patch, Factory UI left untouched (${target.path})`)
      warn(`upgrade path: re-validate against the new version, bump PINNED_FACTORY_UI_VERSION, or pass --force once you have checked the screen`)
      return 0
    }
  }

  const original = readFileSync(target.path, 'utf8')
  if (args.revert) {
    const result = revertFactoryUiPatch(original)
    if (!result.changed) {
      log(`${target.path} is not patched — nothing to revert`)
      return 0
    }
    writeFileSync(target.path, result.html, 'utf8')
    log(`reverted ${target.path}`)
    return 0
  }

  if (args.check) {
    const state = checkFactoryUiPatch(original)
    if (!state.patched) {
      warn(`${target.path} is not patched for @mastra/factory ${factoryVersion ?? 'unknown'} (expected ${PINNED_FACTORY_UI_VERSION})`)
      return 1
    }
    if (state.stale) {
      warn(`${target.path} carries an outdated hitly patch block — re-run without --check`)
      return 1
    }
    log(`${target.path} is patched and current`)
    return 0
  }

  const result = applyFactoryUiPatch(original, { factoryVersion, force: args.force })
  if (result.action === 'skipped') {
    warn(`${result.reason} — skipping the patch, Factory UI left untouched (${target.path})`)
    return 0
  }
  if (!result.changed) {
    log(`${target.path} already patched and current`)
    return 0
  }
  writeFileSync(target.path, result.html, 'utf8')
  log(`${result.action} ${target.path}${result.reason ? ` (${result.reason})` : ''}`)
  return 0
}

process.exit(main(process.argv.slice(2)))
