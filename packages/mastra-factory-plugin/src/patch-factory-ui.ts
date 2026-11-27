/**
 * Version-guarded patch that puts connection cards on the Factory Settings →
 * Connections screen (hitly-net/hitly#218).
 *
 * The Factory SPA is not extensible from the plugin side and is not shipped
 * inside the `@mastra/factory` package: production builds serve it from a
 * separate dist directory (`MASTRACODE_UI_DIST`, `./factory`, or
 * `src/mastra/public/factory`). So the patch does NOT touch minified React
 * chunks — it appends one marker-delimited `<script>` tag to the built
 * `index.html`, pointing at the plugin's own `/cards/boot.js` route. Removal is a
 * single `--revert`, and the whole thing disappears once upstream ships the
 * Connections extension point (hitly-net/hitly#211).
 *
 * Safety rules (the issue's acceptance criteria):
 * - the patch is applied only to the pinned `@mastra/factory` version. Any
 *   other version, a missing version, or a missing patch target means SKIP
 *   with a clear warning and leave the Factory UI byte-for-byte untouched;
 * - applying is idempotent, and `--check` reports drift without writing;
 * - `HITLY_FACTORY_UI_PATCH=0` turns both the patch and the runtime bootstrap
 *   off, with no code change.
 *
 * @mastra-free and fs-free: the pure string transforms live here so tests can
 * exercise them, and scripts/patch-factory-ui.mjs is the only fs caller.
 */

import { BOOT_SCRIPT_PATH } from './connections-boot.ts'

/** The only Factory version this patch is validated against. Bump deliberately, with the UI re-checked. */
export const PINNED_FACTORY_UI_VERSION = '0.30.0'

/** Env off-switch: `0`, `false`, `off`, `no`, or empty disables patching and bootstrapping. */
export const FACTORY_UI_PATCH_ENV = 'HITLY_FACTORY_UI_PATCH'

export const PATCH_START_MARKER = '<!-- hitly:connection-cards:start -->'
export const PATCH_END_MARKER = '<!-- hitly:connection-cards:end -->'

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no', ''])

function hostEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env ?? {}
}

/** Whether the interim Connections patch is enabled. Default: enabled. */
export function isFactoryUiPatchEnabled(env: Record<string, string | undefined> = hostEnv()): boolean {
  const value = env[FACTORY_UI_PATCH_ENV]
  if (value === undefined) return true
  return !DISABLED_VALUES.has(value.trim().toLowerCase())
}

export interface FactoryUiPatchOptions {
  /** URL of the plugin's bootstrap script. Absolute so it survives SPA route rewriting. */
  bootUrl?: string
  /** Version of the installed @mastra/factory, read from its package.json by the CLI. */
  factoryVersion?: string | null
  /** Apply to a non-pinned version anyway (operator escape hatch; logged as such). */
  force?: boolean
}

export interface FactoryUiPatchResult {
  html: string
  /** True when the output differs from the input. */
  changed: boolean
  /** What happened, for operator logs. */
  action: 'applied' | 'updated' | 'unchanged' | 'skipped' | 'reverted' | 'no-op'
  reason?: string
}

/** The exact block written into index.html. Single source of truth for apply and tests. */
export function factoryUiPatchSnippet(options: FactoryUiPatchOptions = {}): string {
  const bootUrl = options.bootUrl ?? BOOT_SCRIPT_PATH
  return `${PATCH_START_MARKER}
<script type="module" src="${bootUrl}"></script>
${PATCH_END_MARKER}`
}

/**
 * Version gate. Anything other than the pinned version (including an
 * unreadable package.json) refuses the patch: an unvalidated injection into a
 * third-party SPA is worse than no cards.
 */
export function checkFactoryUiVersion(
  factoryVersion: string | null | undefined,
  pinned: string = PINNED_FACTORY_UI_VERSION,
): { ok: boolean; reason?: string } {
  if (!factoryVersion) return { ok: false, reason: `could not determine the installed @mastra/factory version (expected ${pinned})` }
  if (factoryVersion !== pinned) return { ok: false, reason: `@mastra/factory ${factoryVersion} is not the pinned ${pinned} this patch is validated against` }
  return { ok: true }
}

/** Locate the insertion point. `</body>` first, then `</head>`, then end of document. */
function insertionPoint(html: string): { index: number; anchor: 'body' | 'head' | 'end' } | null {
  const body = html.toLowerCase().lastIndexOf('</body>')
  if (body >= 0) return { index: body, anchor: 'body' }
  const head = html.toLowerCase().lastIndexOf('</head>')
  if (head >= 0) return { index: head, anchor: 'head' }
  if (/<html/i.test(html) || /<!doctype/i.test(html)) return { index: html.length, anchor: 'end' }
  return null // not an HTML document at all
}

function stripPatch(html: string): string {
  const start = html.indexOf(PATCH_START_MARKER)
  if (start < 0) return html
  const end = html.indexOf(PATCH_END_MARKER, start)
  if (end < 0) {
    // A hand-edited file can lose the end marker. Remove the marker line only:
    // a stray script tag is recoverable, a truncated document is not.
    const lineEnd = html.indexOf('\n', start)
    if (lineEnd < 0) return html.slice(0, start).replace(/\s+$/, '')
    return `${html.slice(0, start)}${html.slice(lineEnd + 1)}`
  }
  let stop = end + PATCH_END_MARKER.length
  if (html[stop] === '\n') stop += 1
  return `${html.slice(0, start)}${html.slice(stop)}`
}

/** True when the marker block is present and identical to what we would write. */
export function isFactoryUiPatchCurrent(html: string, options: FactoryUiPatchOptions = {}): boolean {
  return html.includes(factoryUiPatchSnippet(options))
}

/** State of a file relative to the patch, for `--check`. */
export function checkFactoryUiPatch(html: string, options: FactoryUiPatchOptions = {}): { patched: boolean; stale: boolean } {
  const patched = html.includes(PATCH_START_MARKER)
  return { patched, stale: patched && !isFactoryUiPatchCurrent(html, options) }
}

/** Remove the patch block. Safe on unpatched input. */
export function revertFactoryUiPatch(html: string): FactoryUiPatchResult {
  if (!html.includes(PATCH_START_MARKER)) return { html, changed: false, action: 'no-op', reason: 'not patched' }
  return { html: stripPatch(html), changed: true, action: 'reverted' }
}

/**
 * Idempotently write the bootstrap tag into a built SPA index.html. Refuses to
 * touch anything the version gate rejects, returning the input unchanged.
 */
export function applyFactoryUiPatch(html: string, options: FactoryUiPatchOptions = {}): FactoryUiPatchResult {
  if (!isFactoryUiPatchEnabled()) {
    return { html, changed: false, action: 'skipped', reason: `${FACTORY_UI_PATCH_ENV} disables the Factory Connections patch` }
  }
  const version = checkFactoryUiVersion(options.factoryVersion)
  if (!version.ok && !options.force) {
    return { html, changed: false, action: 'skipped', reason: version.reason }
  }
  const target = insertionPoint(html)
  if (!target) {
    return { html, changed: false, action: 'skipped', reason: 'no </body> or </head> found — this is not a Factory SPA index.html' }
  }
  const base = stripPatch(html)
  const point = insertionPoint(base) ?? target
  const snippet = `${factoryUiPatchSnippet(options)}\n`
  const patched = `${base.slice(0, point.index)}${snippet}${base.slice(point.index)}`
  if (patched === html) return { html, changed: false, action: 'unchanged' }
  return {
    html: patched,
    changed: true,
    action: html.includes(PATCH_START_MARKER) ? 'updated' : 'applied',
    reason: options.force && !version.ok ? `forced past version guard: ${version.reason}` : undefined,
  }
}
