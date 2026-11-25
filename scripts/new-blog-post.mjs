#!/usr/bin/env node
// Scaffold a blog post: yarn blog:new "Post title" [--draft]
// Writes apps/web/content/blog/<slug>.mdx with a schema-valid frontmatter
// skeleton (see apps/web/content/blog/README.md for the authoring guide).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const draft = args.includes('--draft')
const title = args.find((a) => !a.startsWith('--'))

if (!title) {
  console.error('Usage: yarn blog:new "Post title" [--draft]')
  process.exit(1)
}

const slug = title
  .toLowerCase()
  .replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

if (!slug) {
  console.error(`Title "${title}" produced an empty slug.`)
  process.exit(1)
}

// Resolve relative to this script so cwd never matters.
const blogDir = fileURLToPath(new URL('../apps/web/content/blog', import.meta.url))
mkdirSync(blogDir, { recursive: true })
const file = join(blogDir, `${slug}.mdx`)

if (existsSync(file)) {
  console.error(`Refusing to overwrite existing post: ${file}`)
  process.exit(1)
}

const today = new Date().toISOString().slice(0, 10)
const frontmatter = [
  '---',
  `title: "${title.replaceAll('"', '\\"')}"`,
  'description: "TODO: one-line summary, 60-160 characters; used as meta description and RSS summary."',
  `date: ${today}`,
  'tags: []',
  `draft: ${draft}`,
  '---',
  '',
].join('\n')

writeFileSync(file, frontmatter)
console.log(`Created ${join('apps/web/content/blog', `${slug}.mdx`)}`)
console.log('Next: fill the description (60-160 chars), write the body, then read apps/web/content/blog/README.md')
