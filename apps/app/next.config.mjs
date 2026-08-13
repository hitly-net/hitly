/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  transpilePackages: [
    '@hitly/cloud',
    '@hitly/core',
    '@hitly/ui',
    '@hitly/db',
    '@hitly/plugin-mastra',
    '@hitly/plugin-n8n',
    '@hitly/plugin-langgraph',
    '@hitly/plugin-temporal',
  ],
  agentRules: false,
}

export default config
