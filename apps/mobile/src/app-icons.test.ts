import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')

type SplashPluginOptions = {
  image?: string
  resizeMode?: string
  backgroundColor?: string
  dark?: { image?: string; backgroundColor?: string }
}

type AppJson = {
  expo: {
    icon?: string
    plugins: Array<string | [string, Record<string, unknown>?]>
    web?: { favicon?: string }
    android?: {
      adaptiveIcon?: {
        foregroundImage?: string
        backgroundImage?: string
        backgroundColor?: string
        monochromeImage?: string
      }
    }
    ios?: { icon?: string }
    /** Legacy top-level splash config: iOS drops splash.dark here, so the
     * app must use the expo-splash-screen plugin instead. */
    splash?: unknown
  }
}

const appJson = JSON.parse(readFileSync(join(appDir, 'app.json'), 'utf8')) as AppJson

function pluginOptions(name: string): Record<string, unknown> {
  const plugin = appJson.expo.plugins.find(
    (p): p is [string, Record<string, unknown>] => Array.isArray(p) && p[0] === name,
  )
  assert.ok(plugin, `${name} plugin options missing`)
  return plugin[1] ?? {}
}

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

/**
 * Decode a 8-bit RGBA (colour type 6, non-interlaced) PNG into raw
 * scanlines. Enough of a decoder for the alpha-bounds geometry checks
 * below; resvg only ever emits this layout.
 */
function decodeRgbaPng(file: string): { width: number; height: number; pixels: Buffer } {
  const buf = readFileSync(join(appDir, file))
  const header = pngHeader(file)
  assert.equal(header.colorType, 6, `${file}: expected RGBA colour type 6`)
  let offset = 8
  const idat: Buffer[] = []
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(buf.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const { width, height } = header
  const stride = width * 4
  const out = Buffer.alloc(height * stride)
  let pos = 0
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const row = out.subarray(y * stride, (y + 1) * stride)
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? row[x - 4] : 0
      const b = prior ? prior[x] : 0
      const c = prior && x >= 4 ? prior[x - 4] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) v += paeth(a, b, c)
      else assert.equal(filter, 0, `${file}: unknown PNG filter ${filter}`)
      row[x] = v & 0xff
    }
  }
  return { width, height, pixels: out }
}

/**
 * Every (near-)opaque pixel of an adaptive-icon layer must sit inside the
 * circular launcher mask's 66% safe zone (centre 72dp of 108dp, i.e. a
 * circle of radius canvas/3 around the centre). Regression guard for the
 * clipped H stems / check tip: the old 0.68 fraction pushed content out
 * to ~0.39 of the canvas and the mask shaved the extremities off.
 */
function assertInsideSafeZone(file: string): void {
  const { width, height, pixels } = decodeRgbaPng(file)
  assert.equal(width, height, `${file}: expected square layer`)
  const cx = (width - 1) / 2
  const limit = (width / 3) * 1.02 // 1/3 of the canvas + anti-aliasing slack
  let opaquePixels = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = pixels[y * width * 4 + x * 4 + 3]
      if (alpha < 8) continue
      opaquePixels++
      const dist = Math.hypot(x - cx, y - cx)
      assert.ok(
        dist <= limit,
        `${file}: opaque pixel (${x}, ${y}) is ${dist.toFixed(1)}px from centre, outside the 66% safe zone (${limit.toFixed(1)}px)`,
      )
    }
  }
  assert.ok(opaquePixels > 10_000, `${file}: layer looks empty (${opaquePixels} opaque pixels)`)
}

const adaptive = appJson.expo.android?.adaptiveIcon

test('Android adaptive icon is wired to existing 1024px layers', () => {
  assert.ok(adaptive, 'expo.android.adaptiveIcon missing')
  assert.ok(adaptive.foregroundImage, 'foregroundImage missing')
  assert.ok(adaptive.backgroundColor || adaptive.backgroundImage, 'backgroundColor/backgroundImage missing')
  assert.ok(adaptive.monochromeImage, 'monochromeImage missing (Android 13 themed icons)')
  if (adaptive.foregroundImage) assertPng(adaptive.foregroundImage, 1024, { alpha: true })
  if (adaptive.backgroundColor) assert.match(adaptive.backgroundColor, /^#[0-9a-f]{6}$/i)
  if (adaptive.backgroundImage) assertPng(adaptive.backgroundImage, 1024, { alpha: false })
  assertPng(adaptive.monochromeImage!, 1024, { alpha: true })
})

test('adaptive foreground and monochrome fit inside the 66% circular safe zone', () => {
  assert.ok(adaptive?.foregroundImage && adaptive.monochromeImage, 'adaptive layers missing')
  assertInsideSafeZone(adaptive.foregroundImage)
  assertInsideSafeZone(adaptive.monochromeImage)
})

test('top-level expo.icon is a 1024px opaque PNG (Expo Go, pre-Oreo Android)', () => {
  const icon = appJson.expo.icon
  assert.ok(icon, 'expo.icon missing')
  assertPng(icon, 1024, { alpha: false })
})

test('web.favicon is a 48px opaque PNG', () => {
  const favicon = appJson.expo.web?.favicon
  assert.ok(favicon, 'expo.web.favicon missing')
  assertPng(favicon, 48, { alpha: false })
})

test('iOS icon is a 1024px opaque PNG (no alpha)', () => {
  const icon = appJson.expo.ios?.icon
  assert.ok(icon, 'expo.ios.icon missing')
  assertPng(icon, 1024, { alpha: false })
})

test('splash comes from the expo-splash-screen plugin with light and dark variants', () => {
  // The legacy top-level expo.splash drops `dark` on iOS; the config
  // plugin is the supported way to get a dark splash on both platforms.
  assert.equal(appJson.expo.splash, undefined, 'legacy expo.splash must be removed (iOS ignores splash.dark)')
  const splash = pluginOptions('expo-splash-screen') as SplashPluginOptions
  assert.ok(splash.image, 'plugin image missing')
  assert.equal(splash.resizeMode, 'contain')
  assert.equal(splash.backgroundColor?.toLowerCase(), '#fafafa')
  assert.ok(splash.dark?.image, 'plugin dark.image missing (iOS drops legacy splash.dark)')
  assert.equal(splash.dark.backgroundColor?.toLowerCase(), '#18181b')
  assertPng(splash.image, 1024, { alpha: true })
  assertPng(splash.dark.image, 1024, { alpha: true })
})

test('push notification icon is the 96px white-on-transparent source', () => {
  const plugin = pluginOptions('expo-notifications')
  const icon = plugin.icon
  const color = plugin.color
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
  const splash = pluginOptions('expo-splash-screen') as SplashPluginOptions
  const files: Record<string, { svg: string; size: number; alpha: boolean }> = {
    [adaptive!.foregroundImage!]: { svg: brand.adaptiveForegroundSvg(1024), size: 1024, alpha: true },
    [adaptive!.monochromeImage!]: { svg: brand.monochromeMarkSvg(1024), size: 1024, alpha: true },
    // render.ts writes the background through the plain RGBA path (no
    // opaque flag), so pin it the same way.
    'assets/icons/android-background.png': { svg: brand.adaptiveBackgroundSvg(1024), size: 1024, alpha: true },
    [String(pluginOptions('expo-notifications').icon)]: {
      svg: brand.monochromeMarkSvg(96, 0.62),
      size: 96,
      alpha: true,
    },
    [appJson.expo.icon!]: { svg: brand.fullIconSvg(1024), size: 1024, alpha: false },
    [appJson.expo.web!.favicon!]: { svg: brand.fullIconSvg(48), size: 48, alpha: false },
    [appJson.expo.ios!.icon!]: { svg: brand.fullIconSvg(1024), size: 1024, alpha: false },
    [splash.image!]: { svg: brand.splashLogoSvg(1024), size: 1024, alpha: true },
    [splash.dark!.image!]: { svg: brand.splashLogoDarkSvg(1024), size: 1024, alpha: true },
  }
  for (const [file, expected] of Object.entries(files)) {
    assert.ok(file, 'asset path missing from app.json')
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
