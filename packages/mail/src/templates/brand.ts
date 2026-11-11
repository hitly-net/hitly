/**
 * HITLy email branding. One brand colour, one logo, one footer.
 *
 * The logo is the app's own icon (apps/app/app/icon.svg, served by the Next
 * app at /icon.svg). It is referenced as an absolute URL on the app's own
 * host — no third-party image hosts, pixels, or trackers of any kind.
 * Clients that block or strip images show the alt text "HITLy" instead.
 */

export const HITLY_NAME = 'HITLy'
export const HITLY_SITE_URL = 'https://hitly.net'
export const HITLY_TAGLINE = 'Human decisions for your agents.'

/** The single brand colour: the "idle blue" check from the HITLy icon. */
export const BRAND_COLOR = '#2563eb'

/** Neutrals from the same icon (zinc ink + border). */
export const INK_COLOR = '#18181b'
export const MUTED_COLOR = '#52525b'
export const BORDER_COLOR = '#e4e4e7'
export const SURFACE_COLOR = '#f4f4f5'

export const LOGO_ALT = 'HITLy'

/** Absolute URL of the hosted logo on the app's own origin. */
export function logoUrl(appUrl: string): string {
  return new URL('/icon.svg', appUrl).toString()
}

/** Footer "who sent this" line. Static, no tracking links. */
export const FOOTER_SENT_BY = `Sent by ${HITLY_NAME} — you do not need to reply to this email.`
