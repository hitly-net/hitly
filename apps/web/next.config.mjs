import { createMDX } from 'fumadocs-mdx/next'

// HITLY_TELEMETRY unset/off → Next.js and Turbo CLIs do not phone home.
// Keep in sync with apps/web/lib/telemetry.ts and scripts/with-hitly-telemetry.sh.
{
  const value = process.env.HITLY_TELEMETRY?.trim()
  if (value === '1' || value === 'true') {
    delete process.env.NEXT_TELEMETRY_DISABLED
    delete process.env.TURBO_TELEMETRY_DISABLED
  } else {
    process.env.NEXT_TELEMETRY_DISABLED = '1'
    process.env.TURBO_TELEMETRY_DISABLED = '1'
  }
}

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  transpilePackages: ['@hitly/core', '@hitly/ui', 'mermaid'],
  agentRules: false,
}

export default withMDX(config)
