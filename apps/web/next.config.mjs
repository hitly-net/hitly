import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  allowedDevOrigins: ['192.168.68.107'],
  transpilePackages: ['@hitly/core', '@hitly/ui', 'mermaid'],
  agentRules: false,
}

export default withMDX(config)
