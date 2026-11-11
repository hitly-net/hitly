/**
 * Renders every HITLy mobile app icon / splash asset from the SVG sources
 * in ./brand-svg.ts. Deterministic: same inputs -> byte-identical PNGs.
 *
 *   yarn workspace @hitly/mobile icons:generate
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import {
  adaptiveBackgroundSvg,
  adaptiveForegroundSvg,
  fullIconSvg,
  monochromeMarkSvg,
  splashLogoDarkSvg,
  splashLogoSvg,
} from './brand-svg'
import { encodeRgbPng } from './png-encode'

const here = dirname(fileURLToPath(import.meta.url))
const assetsDir = join(here, '..', '..', 'assets')

type Asset = { file: string; svg: string; size: number; opaque?: boolean }

const assets: Asset[] = [
  // Android adaptive icon (1024px sources).
  { file: 'icons/android-foreground.png', svg: adaptiveForegroundSvg(1024), size: 1024 },
  { file: 'icons/android-background.png', svg: adaptiveBackgroundSvg(1024), size: 1024 },
  { file: 'icons/android-monochrome.png', svg: monochromeMarkSvg(1024), size: 1024 },
  // Push notification icon (96px source, white-on-transparent).
  { file: 'icons/notification-icon.png', svg: monochromeMarkSvg(96, 0.62), size: 96 },
  // iOS 1024px icon (opaque, no alpha).
  { file: 'icons/ios-icon.png', svg: fullIconSvg(1024), size: 1024, opaque: true },
  // Splash logos (rendered at 1024, shown centred on the splash backgrounds).
  { file: 'splash/splash-logo.png', svg: splashLogoSvg(1024), size: 1024 },
  { file: 'splash/splash-logo-dark.png', svg: splashLogoDarkSvg(1024), size: 1024 },
]

for (const asset of assets) {
  const resvg = new Resvg(asset.svg, {
    fitTo: { mode: 'width', value: asset.size },
    background: 'rgba(0,0,0,0)',
  })
  const rendered = resvg.render()
  const png = asset.opaque
    ? encodeRgbPng(rendered.pixels, asset.size, asset.size)
    : rendered.asPng()
  const out = join(assetsDir, asset.file)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, png)
  console.log(`wrote ${asset.file} ${asset.size}x${asset.size} (${png.length} bytes)`)
}
