import { defineCollections, defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { pageSchema } from 'fumadocs-core/source/schema'
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins'
import { z } from 'zod'

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

/**
 * Public blog posts (marketing site, /blog). `files` is an explicit *.mdx
 * glob so content/blog/README.md (the authoring guide) is never treated as
 * a post. `date`/`updated` are ISO strings (YYYY-MM-DD) to keep frontmatter
 * diffs stable; see lib/blog.ts for how they are formatted for feeds.
 */
export const blog = defineCollections({
  type: 'doc',
  dir: 'content/blog',
  files: ['**/*.mdx'],
  schema: pageSchema.extend({
    description: z.string().min(60).max(160),
    date: z.string().date(),
    updated: z.string().date().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
})

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMdxMermaid],
  },
})
