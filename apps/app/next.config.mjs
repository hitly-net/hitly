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
    ]
  },
}

export default config
