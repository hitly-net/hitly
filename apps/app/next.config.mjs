/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  allowedDevOrigins: ['192.168.68.107'],
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
