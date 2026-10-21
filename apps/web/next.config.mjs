import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  transpilePackages: ['@hitly/core', '@hitly/ui', 'mermaid'],
  agentRules: false,
}

export default withMDX(config)
