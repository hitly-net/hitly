import { createMDX } from 'fumadocs-mdx/next'
import { applyCliTelemetryDisabled } from '../../scripts/disable-cli-telemetry.mjs'

applyCliTelemetryDisabled()

const withMDX = createMDX()

/**
 * Route redirects. /terms/billing was retired when the full Terms of
 * Service shipped: the Billing Terms are section 6 of /terms, and Stripe
 * Checkout's terms-of-service link must point at
 * https://hitly.net/terms#6-billing-terms (or this redirect).
 */
export const WEB_REDIRECTS = [
  { source: '/terms/billing', destination: '/terms#6-billing-terms', permanent: false },
]

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  transpilePackages: ['@hitly/core', '@hitly/ui', 'mermaid'],
  agentRules: false,
  redirects: async () => WEB_REDIRECTS.map((r) => ({ ...r })),
}

export default withMDX(config)
