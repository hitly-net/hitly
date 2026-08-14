import { defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins'

const processedMarkdown = {
  postprocess: {
    includeProcessedMarkdown: true,
  },
} as const

export const docs = defineDocs({
  dir: 'content/docs',
  docs: processedMarkdown,
})

export const integrations = defineDocs({
  dir: 'content/integrations',
  docs: processedMarkdown,
})

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMdxMermaid],
  },
})
