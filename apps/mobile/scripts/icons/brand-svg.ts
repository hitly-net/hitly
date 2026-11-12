/**
 * Single source of truth for the HITLy app-icon artwork.
 *
 * The geometry is lifted verbatim from the existing web brand assets
 * (apps/app/public/icon.svg / apple-icon.svg): the "H" glyph plus the
 * idle-blue check mark, so the mobile app stays on-brand with the web app.
 * Every generated PNG is rendered from the SVG strings built here, so
 * regenerating assets is fully reproducible:
 *
 *   yarn workspace @hitly/mobile icons:generate
 */

/** Dark zinc tile background used by the web icon. */
export const BRAND_BG = '#18181b'
/** Idle-blue brand accent (the check mark on the web icon). */
export const BRAND_BLUE = '#2563eb'
/** Glyph colour on the dark tile. */
export const BRAND_FG = '#fafafa'

/** The "H" glyph path from apps/app/public/icon.svg (viewBox 0 0 512 512). */
export const H_PATH =
  'M88,56 L168,56 L168,216 L328,216 L328,56 L408,56 L408,456 L328,456 L328,296 L168,296 L168,456 L88,456 Z'

/** The check mark stroke from apps/app/public/icon.svg. */
export const CHECK_PATH = 'M318 372 L362 416 L448 308'

function svg(width: number, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${width}">\n${inner}\n</svg>\n`
}

/**
 * Scale factor + translation that centres the mark's rendered bounding box
 * (the H glyph unioned with the stroked check, i.e. x 56..458, y 30..486
 * in the 512 viewBox) inside `fraction` of the canvas, per layer size.
 */
function markTransform(canvas: number, fraction: number): { scale: number; dx: number; dy: number } {
  const boxX = 56
  const boxY = 30
  const boxW = 458 - 56
  const boxH = 486 - 30
  const scale = (canvas * fraction) / Math.max(boxW, boxH)
  const dx = (canvas - boxW * scale) / 2 - boxX * scale
  const dy = (canvas - boxH * scale) / 2 - boxY * scale
  return { scale, dx, dy }
}

function markGroup(attrs: { hFill: string; checkStroke: string; canvas: number; fraction: number }): string {
  const { scale, dx, dy } = markTransform(attrs.canvas, attrs.fraction)
  return [
    `<g transform="translate(${dx} ${dy}) scale(${scale})">`,
    `  <path d="${H_PATH}" fill="${attrs.hFill}"/>`,
    `  <path d="${CHECK_PATH}" stroke="${attrs.checkStroke}" stroke-width="52" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
    '</g>',
  ].join('\n')
}

/** Full brand lockup (tile + H + check), as used for iOS and legacy icons. */
export function fullIconSvg(size = 1024): string {
  const s = size / 512
  return svg(
    size,
    [
      `<g transform="scale(${s})">`,
      `  <rect width="512" height="512" fill="${BRAND_BG}"/>`,
      `  <path d="${H_PATH}" fill="${BRAND_FG}"/>`,
      `  <path d="${CHECK_PATH}" stroke="${BRAND_BLUE}" stroke-width="52" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
      '</g>',
    ].join('\n'),
  )
}

/**
 * Fraction of the canvas the transform box spans for the adaptive-icon
 * layers. Android masks the 108dp layers with a circle of up to 72dp
 * (radius = 1/3 of the canvas), so the whole mark must fit inside that
 * circle, not just inside the 66% box. The mark's farthest content point
 * is the top-left corner of the H's left stem at (88, 56) in the 512
 * viewBox, 263.4 units from the centre of the 402x456 transform box
 * (centre 257, 258), so the circle fits when
 *
 *   263.4 * (fraction / 456) <= 1/3   =>   fraction <= 0.577
 *
 * 0.57 keeps a ~4px anti-aliasing margin inside the safe zone at 1024px.
 * (The old 0.68 pushed the H stems and the check tip outside the circle
 * and the launcher mask clipped them.)
 */
export const ADAPTIVE_MARK_FRACTION = 0.57

/**
 * Android adaptive-icon foreground layer: mark only (tileless), scaled to
 * fit inside the circular launcher mask's 66% safe zone.
 */
export function adaptiveForegroundSvg(size = 1024): string {
  return svg(size, markGroup({ hFill: BRAND_FG, checkStroke: BRAND_BLUE, canvas: size, fraction: ADAPTIVE_MARK_FRACTION }))
}

/** Android adaptive-icon background layer: solid brand tile colour. */
export function adaptiveBackgroundSvg(size = 1024): string {
  return svg(size, `<rect width="${size}" height="${size}" fill="${BRAND_BG}"/>`)
}

/**
 * Android 13+ themed-icon (monochrome) layer and push notification icon:
 * white mark on transparent. The check is outlined so it stays readable
 * where it overlaps the H.
 */
export function monochromeMarkSvg(size = 1024, fraction = ADAPTIVE_MARK_FRACTION): string {
  const inner = [
    markGroup({ hFill: '#ffffff', checkStroke: 'transparent', canvas: size, fraction }),
    `<g transform="translate(${markTransform(size, fraction).dx} ${markTransform(size, fraction).dy}) scale(${markTransform(size, fraction).scale})">`,
    `  <path d="${CHECK_PATH}" stroke="#ffffff" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
    '</g>',
  ].join('\n')
  return svg(size, inner)
}

/** Splash logo: full-colour mark on transparent (centred, tighter than icon). */
export function splashLogoSvg(size = 1024): string {
  return svg(size, markGroup({ hFill: BRAND_BG, checkStroke: BRAND_BLUE, canvas: size, fraction: 0.42 }))
}

/** Splash logo for dark backgrounds (light glyph). */
export function splashLogoDarkSvg(size = 1024): string {
  return svg(size, markGroup({ hFill: BRAND_FG, checkStroke: BRAND_BLUE, canvas: size, fraction: 0.42 }))
}
