import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOOT_SCRIPT_PATH,
  DEFAULT_ANCHOR_SELECTORS,
  DEFAULT_ANCHOR_TEXTS,
  anchorSelectorsWithEnv,
  renderConnectionsBootScript,
} from './connections-boot.ts'
import { SETTINGS_BASE_PATH } from './settings-routes.ts'

/**
 * The bootstrap runs inside a third-party SPA it does not own, so these tests
 * pin the properties that keep that safe: it must parse on its own, stay
 * dependency-free, fail only by warning, and never render server text as HTML.
 */

const script = renderConnectionsBootScript({ basePath: SETTINGS_BASE_PATH })

test('the bootstrap is a self-contained script the browser can execute directly', () => {
  // Proves it parses standalone (no ESM, no bundler, no template leftovers).
  assert.doesNotThrow(() => new Function(script), 'the rendered bootstrap must be valid script text')
  assert.ok(script.startsWith('(function () {'), 'one immediately-invoked closure, no globals leaked')
  for (const forbidden of ['import ', 'require(', 'export ', 'process.env', '__dirname']) {
    assert.ok(!script.includes(forbidden), `no ${forbidden} — it is served raw to the browser`)
  }
})

test('it is pointed at the plugin settings base and the gated cards route beside it', () => {
  assert.ok(script.includes(`"basePath":${JSON.stringify(SETTINGS_BASE_PATH)}`))
  assert.ok(script.includes("OPT.basePath + '/cards/api'"), 'cards come from the same-origin, org-admin-gated API')
  assert.equal(BOOT_SCRIPT_PATH, `${SETTINGS_BASE_PATH}/cards/boot.js`, 'the patch tag and the route agree')
})

test('it stays inert when switched off or already booted', () => {
  assert.match(script, /globalThis\.__HITLY_FACTORY_UI_PATCH__ === false\)\s*return/)
  assert.match(script, /globalThis\.__HITLY_CONNECTIONS_BOOTED__/)
  assert.ok(
    script.indexOf('__HITLY_FACTORY_UI_PATCH__') < script.indexOf('var OPT'),
    'the off-switch is checked before any work happens',
  )
})

test('it finds the Connections screen by selector first, heading text second', () => {
  for (const selector of DEFAULT_ANCHOR_SELECTORS) assert.ok(script.includes(JSON.stringify(selector)))
  for (const text of DEFAULT_ANCHOR_TEXTS) assert.ok(script.includes(JSON.stringify(text)))
  assert.ok(
    script.indexOf('document.querySelector(OPT.anchorSelectors[i])') < script.indexOf("querySelectorAll('h1, h2, h3')"),
    'selectors are tried before headings',
  )
})

test('untrusted card text reaches the DOM as text, never as markup', () => {
  assert.ok(!/innerHTML|outerHTML|document\.write|insertAdjacentHTML/.test(script), 'no HTML sinks at all')
  assert.match(script, /node\.textContent = text == null \? '' : String\(text\)/)
  assert.match(script, /name\.textContent = card\.name \|\| card\.id/, 'the name falls back to the id, still as text')
  assert.match(script, /status\.textContent = card\.label \|\| card\.status/)
})

test('the settings link is only rendered when the server supplied a path', () => {
  assert.match(script, /if \(card\.settingsPath\) \{[\s\S]*?link\.href = card\.settingsPath/)
  assert.ok(!script.includes('href="#"'), 'no dead link is rendered for a card without a settings page')
})

test('every host-page interaction is guarded, so a broken observer cannot take Factory down', () => {
  assert.ok(script.includes('function warn()'), 'failures are console.warn, not throws')
  assert.ok(script.includes("catch (e) { warn("), 'the anchor lookup swallows failures')
  // Nothing may reject or throw out of the tick: the only console call is warn.
  assert.ok(!script.includes('console.error'), 'the host console stays clean of noise we cannot control')
  assert.ok(script.includes('MutationObserver'), 'the screen is watched, not polled flat out')
  assert.ok(script.includes('OPT.maxWaitMs'), 'watching gives up eventually instead of running forever')
})

test('the fetch stays same-origin and asks for json', () => {
  assert.match(script, /credentials:\s*'same-origin'/)
  assert.match(script, /accept:\s*'application\/json'/)
})

test('the fallback poll stops instead of watching the host page forever', () => {
  assert.match(script, /hasObserver = true/, 'the observer is the primary trigger, the interval the fallback')
  assert.match(script, /if \(!hasObserver\) return;\s*if \(lastCards \|\| Date\.now\(\) - started > OPT\.maxWaitMs\) clearInterval\(timer\)/,
    'with an observer attached, the poll ends once cards are up or the screen has clearly not come')
})

test('the operator anchor override is prepended, never replaces the built-in anchors', () => {
  assert.deepEqual(anchorSelectorsWithEnv({}), DEFAULT_ANCHOR_SELECTORS)
  assert.deepEqual(anchorSelectorsWithEnv({ HITLY_CONNECTION_CARDS_ANCHOR: '   ' }), DEFAULT_ANCHOR_SELECTORS)
  assert.deepEqual(anchorSelectorsWithEnv({ HITLY_CONNECTION_CARDS_ANCHOR: ' #conn ' }), [
    '#conn',
    ...DEFAULT_ANCHOR_SELECTORS,
  ])
})
