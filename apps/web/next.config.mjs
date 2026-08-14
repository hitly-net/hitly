import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  transpilePackages: ['@hitly/core', '@hitly/ui', 'mermaid'],
  agentRules: false,
}

export default withMDX(config)
