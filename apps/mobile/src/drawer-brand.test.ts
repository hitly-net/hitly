import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// The drawer header must show the current H-and-check brand mark, not the
// old "HUMAN in the LOOP" typographic lockup (which clipped its text at the
// drawer's 48px size). Pin the wiring at the source level; the pixel
// correctness of app-icon.png itself is guarded by app-icons.test.ts.

const here = dirname(fileURLToPath(import.meta.url))
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const appMenu = strip(readFileSync(join(here, 'components', 'nav', 'AppMenu.tsx'), 'utf8'))
const brand = strip(readFileSync(join(here, 'components', 'brand', 'HitlyBrand.tsx'), 'utf8'))

test('drawer header uses the brand tile next to the HITLy wordmark', () => {
  assert.match(appMenu, /import \{ HitlyBrandTile, HitlyWordmark \} from '..\/brand\/HitlyBrand'/)
  assert.match(appMenu, /<HitlyBrandTile size=\{48\} \/>/)
  assert.match(appMenu, /<HitlyWordmark size=\{20\} \/>/)
  assert.doesNotMatch(appMenu, /HitlyMark/, 'the typographic lockup no longer belongs in the drawer')
})

test('brand tile renders the app-icon asset, uncropped', () => {
  assert.match(
    brand,
    /export function HitlyBrandTile\(\{ size = 48 \}/,
    'HitlyBrandTile must exist as the image-based brand mark',
  )
  assert.match(brand, /source=\{require\('\.\.\/\.\.\/\.\.\/assets\/icons\/app-icon\.png'\)\}/)
  assert.match(brand, /accessibilityLabel="HITLy"/)
  // Dead View-built H glyph: removed by #205, must not come back.
  assert.doesNotMatch(brand, /export function HitlyH\b/)
  // Still alive for the sign-in welcome screen.
  assert.match(brand, /export function HitlyMark\b/)
})
