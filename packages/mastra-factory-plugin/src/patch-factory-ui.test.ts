import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FACTORY_UI_PATCH_ENV,
  PATCH_END_MARKER,
  PATCH_START_MARKER,
  PINNED_FACTORY_UI_VERSION,
  applyFactoryUiPatch,
  checkFactoryUiPatch,
  checkFactoryUiVersion,
  factoryUiPatchSnippet,
  isFactoryUiPatchEnabled,
  revertFactoryUiPatch,
} from './patch-factory-ui.ts'
import { BOOT_SCRIPT_PATH } from './connections-boot.ts'

/**
 * The Factory UI patch is applied to a third-party build, so the guard rails
 * matter more than the patch itself: wrong version, missing version, or a file
 * that is not the SPA must leave the HTML byte-for-byte untouched.
 */

const PRISTINE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Factory</title></head>
  <body><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script></body>
</html>
`

function apply(html = PRISTINE, options: Parameters<typeof applyFactoryUiPatch>[1] = {}) {
  return applyFactoryUiPatch(html, { factoryVersion: PINNED_FACTORY_UI_VERSION, ...options })
}

test('patch is enabled by default and switched off by the documented values', () => {
  assert.equal(isFactoryUiPatchEnabled({}), true)
  for (const value of ['0', 'false', 'FALSE', ' off ', 'no', '']) {
    assert.equal(isFactoryUiPatchEnabled({ [FACTORY_UI_PATCH_ENV]: value }), false, `${JSON.stringify(value)} disables it`)
  }
  for (const value of ['1', 'true', 'on', 'yes']) {
    assert.equal(isFactoryUiPatchEnabled({ [FACTORY_UI_PATCH_ENV]: value }), true, `${JSON.stringify(value)} keeps it on`)
  }
})

test('version gate accepts only the pinned @mastra/factory', () => {
  assert.equal(checkFactoryUiVersion(PINNED_FACTORY_UI_VERSION).ok, true)
  assert.equal(checkFactoryUiVersion('0.29.0').ok, false)
  assert.equal(checkFactoryUiVersion(null).ok, false)
  assert.equal(checkFactoryUiVersion(undefined).ok, false)
  assert.match(checkFactoryUiVersion('0.31.0').reason ?? '', /0\.31\.0/)
  assert.match(checkFactoryUiVersion('0.31.0').reason ?? '', /pinned/)
  assert.match(checkFactoryUiVersion(null).reason ?? '', /could not determine/)
})

test('apply inserts the bootstrap module before </body>, pointing at the plugin route', () => {
  const result = apply()
  assert.equal(result.action, 'applied')
  assert.equal(result.changed, true)
  assert.ok(result.html.includes(PATCH_START_MARKER))
  assert.ok(result.html.includes(PATCH_END_MARKER))
  assert.ok(result.html.includes(`src="${BOOT_SCRIPT_PATH}"`))
  assert.ok(result.html.indexOf(PATCH_START_MARKER) < result.html.indexOf('</body>'), 'the tag lands inside the document')
  assert.ok(result.html.includes('/assets/index-abc123.js'), 'the SPA bundle itself is untouched')
})

test('apply is idempotent: a second run writes nothing and leaves exactly one block', () => {
  const once = apply()
  const twice = apply(once.html)
  assert.equal(twice.changed, false)
  assert.equal(twice.action, 'unchanged')
  assert.equal(twice.html, once.html)
  assert.equal(twice.html.split(PATCH_START_MARKER).length - 1, 1, 'never stacks duplicate blocks')
})

test('apply refreshes a stale block instead of stacking it', () => {
  const first = apply()
  const moved = apply(first.html, { bootUrl: '/custom/boot.js' })
  assert.equal(moved.action, 'updated')
  assert.equal(moved.html.split(PATCH_START_MARKER).length - 1, 1)
  assert.ok(moved.html.includes('/custom/boot.js'))
  assert.ok(!moved.html.includes(BOOT_SCRIPT_PATH), 'the old script tag is replaced, not appended to')
})

test('a non-pinned or unknown Factory version skips and leaves the html byte-identical', () => {
  for (const version of ['0.29.0', '0.31.0', null, undefined]) {
    const result = applyFactoryUiPatch(PRISTINE, { factoryVersion: version })
    assert.equal(result.action, 'skipped', `${version} must not be patched`)
    assert.equal(result.changed, false)
    assert.equal(result.html, PRISTINE, 'a skipped patch writes nothing')
    assert.ok(result.reason)
  }
})

test('--force is the operator escape hatch and says so in the reason', () => {
  const result = apply(PRISTINE, { factoryVersion: '0.31.0', force: true })
  assert.equal(result.action, 'applied')
  assert.match(result.reason ?? '', /forced/)
})

test('a file that is not the SPA index is refused, not patched', () => {
  for (const junk of ['', 'not html at all', '<div>fragment</div>']) {
    const result = apply(junk)
    assert.equal(result.action, 'skipped', `${JSON.stringify(junk.slice(0, 12))}`)
    assert.equal(result.html, junk)
  }
})

test('falls back to </head> when the built document has no </body>', () => {
  const headOnly = '<!doctype html><html><head><title>x</title></head></html>'
  const result = apply(headOnly)
  assert.equal(result.action, 'applied')
  assert.ok(result.html.indexOf(PATCH_START_MARKER) < result.html.indexOf('</head>'))
})

test('--check distinguishes unpatched, current, and stale', () => {
  assert.deepEqual(checkFactoryUiPatch(PRISTINE), { patched: false, stale: false })
  const current = apply().html
  assert.deepEqual(checkFactoryUiPatch(current), { patched: true, stale: false })
  const handEdited = current.replace(BOOT_SCRIPT_PATH, '/somewhere/else.js')
  assert.deepEqual(checkFactoryUiPatch(handEdited), { patched: true, stale: true })
})

test('revert restores the built file byte-for-byte and is safe on unpatched input', () => {
  const patched = apply().html
  const reverted = revertFactoryUiPatch(patched)
  assert.equal(reverted.action, 'reverted')
  assert.equal(reverted.html, PRISTINE)
  const again = revertFactoryUiPatch(PRISTINE)
  assert.equal(again.action, 'no-op')
  assert.equal(again.html, PRISTINE)
})

test('a half-written block (missing end marker) is still removable without eating the document', () => {
  const broken = `${PRISTINE}${PATCH_START_MARKER}\n<script src="/x.js"></script>\n`
  const reverted = revertFactoryUiPatch(broken)
  assert.equal(reverted.changed, true)
  assert.ok(!reverted.html.includes(PATCH_START_MARKER))
  assert.ok(reverted.html.includes('</body>'), 'the built document survives a hand-edited patch block')
  assert.equal(revertFactoryUiPatch(reverted.html).action, 'no-op')
})

test('the env off-switch also stops apply, without a code change', () => {
  process.env[FACTORY_UI_PATCH_ENV] = '0'
  try {
    const result = apply()
    assert.equal(result.action, 'skipped')
    assert.equal(result.html, PRISTINE)
    assert.match(result.reason ?? '', /HITLY_FACTORY_UI_PATCH/)
  } finally {
    delete process.env[FACTORY_UI_PATCH_ENV]
  }
})

test('the pinned version and the devDependency pin move together', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { devDependencies: Record<string, string> }
  assert.equal(
    pkg.devDependencies['@mastra/factory'],
    PINNED_FACTORY_UI_VERSION,
    'the patch is validated against the Factory version the plugin is developed against — bump both or neither',
  )
})

test('the snippet is the single source of truth for apply and check', () => {
  const snippet = factoryUiPatchSnippet()
  assert.ok(PRISTINE.includes('</body>'))
  assert.equal(checkFactoryUiPatch(PRISTINE + snippet + '\n').stale, false)
})

test('the pinned version is the version this package is developed and typechecked against', () => {
  // The patch is written against one shipped Factory build. If the dev pin and
  // the patch constant ever disagree, the patch would be applied to a Factory
  // nobody validated it against.
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>
  }
  assert.equal(pkg.devDependencies?.['@mastra/factory'], PINNED_FACTORY_UI_VERSION)
})
