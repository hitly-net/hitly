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
}

export default config
