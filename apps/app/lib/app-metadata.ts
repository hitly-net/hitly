import type { Metadata } from 'next'

/**
 * Root layout metadata, kept in its own module so a unit test can import the
 * exported object directly (importing the layout would pull next/font and
 * next/headers into the test).
 *
 * The icon is declared EXPLICITLY because the brand SVGs are served from
 * public/ (see the BRAND_ASSET_PATHS note in lib/constants.ts): with no
 * icon file in app/, Next injects no <link rel="icon"> on its own, and
 * signed-out pages (login, signup, reset, invite, verify-email) would ship
 * without a favicon. This gives every page a static <link rel="icon"
 * href="/icon.svg" type="image/svg+xml">; components/favicon-updater.tsx
 * then swaps that link's href to /icon-open.svg when the inbox has pending
 * items. lib/brand-assets.test.ts pins this metadata; the CI workflow
 * asserts the rendered /login HTML actually carries the link.
 */
export const metadata: Metadata = {
  title: { default: 'HITLy', template: '%s — HITLy' },
  description: 'HITLy — approval inbox for agent work',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
  },
}
