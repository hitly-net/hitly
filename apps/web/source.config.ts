import { defineConfig, defineDocs } from 'fumadocs-mdx/config'

export const docs = defineDocs({
  dir: 'content/docs',
})

export const integrations = defineDocs({
  dir: 'content/integrations',
})

export default defineConfig()
