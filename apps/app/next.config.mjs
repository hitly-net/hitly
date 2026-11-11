// HITLY_TELEMETRY unset/off → Next.js CLI does not phone home. Keep in sync with
// apps/web/lib/telemetry.ts and scripts/with-hitly-telemetry.sh.
{
  const value = process.env.HITLY_TELEMETRY?.trim()
  if (value === '1' || value === 'true') delete process.env.NEXT_TELEMETRY_DISABLED
  else process.env.NEXT_TELEMETRY_DISABLED = '1'
}

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  transpilePackages: [
    '@hitly/mail',
    '@hitly/cloud',
    '@hitly/core',
    '@hitly/ui',
    '@hitly/db',
    '@hitly/plugin-hermes',
    '@hitly/plugin-mastra',
    '@hitly/plugin-http',
    '@hitly/plugin-langgraph',
    '@hitly/plugin-temporal',
  ],
  agentRules: false,
  async headers() {
    return [
      {
        // The reset link carries its token in the URL; keep it out of Referer headers.
        source: '/reset-password',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        // Email-change confirmation links carry their token in the query string.
        source: '/verify-email-change',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        // Workspace invite links carry their token in the path.
        source: '/invite/:token*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        // /signup?invite=<token> redirects to /invite/<token>.
        source: '/signup',
        has: [{ type: 'query', key: 'invite' }],
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
    ]
  },
}

export default config
