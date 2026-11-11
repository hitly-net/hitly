import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')

type AppJson = {
  expo: {
    plugins: Array<string | [string, Record<string, unknown>?]>
    android?: {
      adaptiveIcon?: {
        foregroundImage?: string
        backgroundImage?: string
        backgroundColor?: string
        monochromeImage?: string
      }
    }
    ios?: { icon?: string }
    splash?: {
      image?: string
      resizeMode?: string
      backgroundColor?: string
      dark?: { image?: string; backgroundColor?: string }
    }
  }
}

const appJson = JSON.parse(readFileSync(join(appDir, 'app.json'), 'utf8')) as AppJson

/** Minimal PNG header reader: width, height, bit depth, colour type. */
function pngHeader(file: string): { width: number; height: number; bitDepth: number; colorType: number } {
  const buf = readFileSync(join(appDir, file))
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file}: not a PNG`)
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR', `${file}: IHDR must be the first chunk`)
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf.readUInt8(24),
    colorType: buf.readUInt8(25),
  }
}

const hasAlpha = (colorType: number) => colorType === 4 || colorType === 6

function assertPng(file: string, size: number, opts: { alpha: boolean }): void {
  const header = pngHeader(file)
  assert.equal(header.width, size, `${file}: width`)
  assert.equal(header.height, size, `${file}: height`)
  assert.equal(header.bitDepth, 8, `${file}: bit depth`)
  assert.equal(hasAlpha(header.colorType), opts.alpha, `${file}: alpha channel expected ${opts.alpha}`)
}

test('Android adaptive icon is wired to existing 1024px layers', () => {
  const adaptive = appJson.expo.android?.adaptiveIcon
  assert.ok(adaptive, 'expo.android.adaptiveIcon missing')
  assert.ok(adaptive.foregroundImage, 'foregroundImage missing')
  assert.ok(adaptive.backgroundColor || adaptive.backgroundImage, 'backgroundColor/backgroundImage missing')
  assert.ok(adaptive.monochromeImage, 'monochromeImage missing (Android 13 themed icons)')
  if (adaptive.foregroundImage) assertPng(adaptive.foregroundImage, 1024, { alpha: true })
  if (adaptive.backgroundColor) assert.match(adaptive.backgroundColor, /^#[0-9a-f]{6}$/i)
  if (adaptive.backgroundImage) assertPng(adaptive.backgroundImage, 1024, { alpha: false })
  assertPng(adaptive.monochromeImage!, 1024, { alpha: true })
})

test('iOS icon is a 1024px opaque PNG (no alpha)', () => {
  const icon = appJson.expo.ios?.icon
  assert.ok(icon, 'expo.ios.icon missing')
  assertPng(icon, 1024, { alpha: false })
})

test('splash screen is configured for light and dark with existing images', () => {
  const splash = appJson.expo.splash
  assert.ok(splash?.image, 'expo.splash.image missing')
  assert.equal(splash.resizeMode, 'contain')
  assert.match(splash.backgroundColor ?? '', /^#[0-9a-f]{6}$/i)
  assert.ok(splash.dark?.image, 'expo.splash.dark.image missing')
  assert.match(splash.dark.backgroundColor ?? '', /^#[0-9a-f]{6}$/i)
  assertPng(splash.image, 1024, { alpha: true })
  assertPng(splash.dark.image, 1024, { alpha: true })
})

test('push notification icon is the 96px white-on-transparent source', () => {
  const plugin = appJson.expo.plugins.find(
    (p): p is [string, Record<string, unknown>] => Array.isArray(p) && p[0] === 'expo-notifications',
  )
  assert.ok(plugin, 'expo-notifications plugin options missing')
  const icon = plugin[1]?.icon
  const color = plugin[1]?.color
  assert.ok(typeof icon === 'string' && icon.length > 0, 'plugin icon missing')
  assert.match(String(color), /^#[0-9a-f]{6}$/i)
  assertPng(String(icon), 96, { alpha: true })
})

test('notification channel tints with the brand colour', () => {
  const source = readFileSync(join(appDir, 'src/providers/NativePushProvider.tsx'), 'utf8')
  assert.match(source, /setNotificationChannelAsync\('hitly',\s*\{[\s\S]*?lightColor:\s*'#2563eb'/)
})

test('generated PNGs are byte-reproducible from the committed SVG sources', async () => {
  // Render every configured asset again via the same script the generator
  // uses and compare bytes. Guards against committing assets that drifted
  // from scripts/icons/.
  const { Resvg } = await import('@resvg/resvg-js')
  const brand = await import('../scripts/icons/brand-svg')
  const { encodeRgbPng } = await import('../scripts/icons/png-encode')
  const files: Record<string, { svg: string; size: number; alpha: boolean }> = {
    [appJson.expo.android!.adaptiveIcon!.foregroundImage!]: { svg: brand.adaptiveForegroundSvg(1024), size: 1024, alpha: true },
    [appJson.expo.android!.adaptiveIcon!.monochromeImage!]: { svg: brand.monochromeMarkSvg(1024), size: 1024, alpha: true },
    [appJson.expo.ios!.icon!]: { svg: brand.fullIconSvg(1024), size: 1024, alpha: false },
    [appJson.expo.splash!.image!]: { svg: brand.splashLogoSvg(1024), size: 1024, alpha: true },
    [appJson.expo.splash!.dark!.image!]: { svg: brand.splashLogoDarkSvg(1024), size: 1024, alpha: true },
  }
  for (const [file, expected] of Object.entries(files)) {
    const rendered = new Resvg(expected.svg, {
      fitTo: { mode: 'width', value: expected.size },
      background: 'rgba(0,0,0,0)',
    })
      .render()
    const png = expected.alpha
      ? rendered.asPng()
      : encodeRgbPng(rendered.pixels, expected.size, expected.size)
    // Compare bytes exactly: assets must match a fresh render of the
    // committed SVG sources (regenerate with `yarn icons:generate`).
    const committed = readFileSync(join(appDir, file))
    assert.equal(png.length, committed.length, `${file}: byte length drifted from SVG source`)
    assert.deepEqual(Buffer.compare(png, committed), 0, `${file}: re-run yarn icons:generate`)
  }
})
