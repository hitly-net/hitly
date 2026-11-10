/**
 * Server-side QR rendering for an otpauth URI. Generated locally with `uqr`
 * (no network); the URI itself is never logged here.
 */

import { renderSVG } from 'uqr'

export function renderOtpauthQr(uri: string): string {
  return renderSVG(uri, { pixelSize: 4, whiteColor: '#fff', blackColor: '#111' })
}
