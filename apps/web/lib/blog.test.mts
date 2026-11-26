import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Must precede any @/lib import: registers the fumadocs .source loader.
await import('./test/preload.mjs')

const { publishedPosts } = await import('@/lib/source')
const {
  BLOG_DISCLAIMER,
  BLOG_INDEX_PATH,
  FEED_PATH,
  blogIndexJsonLd,
  blogPostJsonLd,
  blogPostMeta,
  buildRssFeed,
  formatPostDate,
  jsonLdScript,
  postModified,
  postUrl,
  toRfc822,
} = await import('@/lib/blog')
const { MARKETING_ROUTES, SITE_URL, buildSitemap } = await import('@/lib/site')

// node --test runs with cwd = apps/web.
const WEB_ROOT = process.cwd()
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const BLOG_DIR = join(WEB_ROOT, 'content', 'blog')
const readRaw = (name: string) => readFileSync(join(BLOG_DIR, name), 'utf8')
const bodyOf = (raw: string) => raw.replace(/^---\n[\s\S]*?\n---\n/, '')

const LAUNCH_POSTS = ['fca-agentic-ai-expectations', 'eu-ai-act-financial-services']
const ALLOWED_HOST_SUFFIXES = [
  'fca.org.uk',
  'esma.europa.eu',
  'eba.europa.eu',
  'eiopa.europa.eu',
  'eur-lex.europa.eu',
  'digital-strategy.ec.europa.eu',
  'ec.europa.eu',
  'europa.eu',
  'hitly.net',
]

function publishedMdxFiles() {
  return readdirSync(BLOG_DIR).filter((f) => f.endsWith('.mdx'))
}

test('launch posts exist and are published', () => {
  const posts = publishedPosts()
  for (const slug of LAUNCH_POSTS) {
    assert.ok(existsSync(join(BLOG_DIR, `${slug}.mdx`)), `missing ${slug}.mdx`)
    assert.ok(posts.some((p) => p.slugs.join('/') === slug), `${slug} not in publishedPosts()`)
  }
})

test('every .mdx file is published or an explicit draft; drafts never leak', () => {
  for (const file of publishedMdxFiles()) {
    const raw = readRaw(file)
    const isDraft = /^draft:\s*true\s*$/m.test(raw)
    const slug = file.replace(/\.mdx$/, '')
    const inFeed = publishedPosts().some((p) => p.slugs.join('/') === slug)
    assert.equal(inFeed, !isDraft, `${file}: published=${!isDraft} but in publishedPosts=${inFeed}`)
  }
})

test('published posts are sorted newest first', () => {
  const dates = publishedPosts().map((p) => p.data.date)
  const sorted = [...dates].sort((a, b) => b.localeCompare(a))
  assert.deepEqual(dates, sorted)
})

test('frontmatter descriptions are 60-160 characters', () => {
  for (const file of publishedMdxFiles()) {
    const match = readRaw(file).match(/^description: "?([^"\n]*)"?\s*$/m)
    assert.ok(match, `${file}: no description in frontmatter`)
    const len = match[1].trim().length
    assert.ok(len >= 60 && len <= 160, `${file}: description length ${len} outside 60-160`)
  }
})

test('post bodies contain no code, imports, or JSX (content-only corpus)', () => {
  for (const file of publishedMdxFiles()) {
    const body = bodyOf(readRaw(file))
    assert.doesNotMatch(body, /^import\s/m, `${file}: import statement banned`)
    assert.doesNotMatch(body, /^export\s/m, `${file}: export statement banned`)
    assert.doesNotMatch(body, /process\.env/, `${file}: process.env banned`)
    assert.doesNotMatch(body, /<[A-Za-z]/, `${file}: raw JSX tags banned`)
  }
})

test('post bodies contain no images, so the alt-text rule holds', () => {
  for (const file of publishedMdxFiles()) {
    const body = bodyOf(readRaw(file))
    assert.doesNotMatch(body, /!\[/, `${file}: markdown images not used in this corpus`)
    assert.doesNotMatch(body, /<img/, `${file}: <img> banned`)
  }
})

test('external links point only at allowed official domains', () => {
  for (const file of publishedMdxFiles()) {
    const body = bodyOf(readRaw(file))
    for (const [, href] of body.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
      const host = new URL(href).hostname.toLowerCase()
      assert.ok(
        ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)),
        `${file}: disallowed external host ${host}`,
      )
    }
  }
})

test('internal links are site-relative', () => {
  for (const file of publishedMdxFiles()) {
    const body = bodyOf(readRaw(file))
    for (const [, href] of body.matchAll(/\]\((?!https?:|mailto:)([^)\s]+)\)/g)) {
      assert.ok(href.startsWith('/'), `${file}: internal link must start with / (got ${href})`)
    }
  }
})

test('post corpus contains no private IP addresses', () => {
  const rfc1918 = /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/
  for (const file of publishedMdxFiles()) {
    const raw = readRaw(file)
    assert.ok(!rfc1918.test(raw), `${file}: contains private IP`)
    // The registered mark belongs to the legal-notice page only.
    assert.ok(!raw.includes('®'), `${file}: ® banned on the blog`)
  }
})

test('post bodies make no compliance claims for HITLy', () => {
  const claim = /HITLy[^.?!]*\b(?:is|are|makes you|meets|satisfies|ensures|guarantees)\b[^.?!]*\b(?:compliant|compliance|authorised|regulated|approved|oversight requirement)/i
  for (const file of publishedMdxFiles()) {
    assert.doesNotMatch(bodyOf(readRaw(file)), claim, `${file}: possible compliance claim`)
  }
})

test('BLOG_DISCLAIMER carries the required statements and never uses the registered mark', () => {
  assert.match(BLOG_DISCLAIMER, /technology provider/)
  assert.match(BLOG_DISCLAIMER, /not authorised or regulated by the Financial Conduct Authority/)
  assert.match(BLOG_DISCLAIMER, /not a law firm/)
  assert.match(BLOG_DISCLAIMER, /legal or regulatory advice/)
  assert.ok(!BLOG_DISCLAIMER.includes('®'))
  assert.ok(!/complian/i.test(BLOG_DISCLAIMER.replace(/complies with any regulation/, '')))
})

test('date helpers format for en-GB readers and RFC-822 feeds', () => {
  assert.equal(formatPostDate('2026-11-25'), '25 November 2026')
  assert.equal(toRfc822('2026-11-25'), 'Wed, 25 Nov 2026 00:00:00 GMT')
  assert.throws(() => toRfc822('25/11/2026'))
  assert.equal(postModified({ date: '2026-01-01', updated: '2026-02-02' }), '2026-02-02')
  assert.equal(postModified({ date: '2026-01-01' }), '2026-01-01')
})

test('postUrl and sitemap expose absolute https URLs without trailing slashes', () => {
  for (const post of publishedPosts()) {
    const url = postUrl(post)
    assert.match(url, /^https:\/\/hitly\.net\/blog\/[a-z0-9-]+$/)
  }
  const sitemap = buildSitemap()
  const urls = sitemap.map((e) => e.url)
  assert.ok(urls.includes(`${SITE_URL}${BLOG_INDEX_PATH}`), 'sitemap missing /blog')
  for (const post of publishedPosts()) {
    assert.ok(urls.includes(postUrl(post)), `sitemap missing ${post.url}`)
  }
  assert.ok(MARKETING_ROUTES.includes('/blog'), 'MARKETING_ROUTES missing /blog')
})

test('RSS feed is well-formed RSS 2.0 covering every published post', () => {
  const xml = buildRssFeed()
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  assert.match(xml, /<rss version="2\.0"/)
  assert.match(xml, /<language>en-gb<\/language>/)
  assert.match(xml, new RegExp(`<atom:link href="${SITE_URL}${FEED_PATH}" rel="self"`))
  // No bare ampersands outside known entities.
  assert.equal((xml.match(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/g) ?? []).length, 0)
  for (const post of publishedPosts()) {
    const link = postUrl(post)
    assert.ok(xml.includes(`<guid isPermaLink="true">${link}</guid>`), `feed missing ${link}`)
    assert.match(xml, new RegExp(`<pubDate>[A-Z][a-z]{2}, \\d{2} [A-Z][a-z]{2} \\d{4} 00:00:00 GMT</pubDate>`))
  }
  assert.equal((xml.match(/<item>/g) ?? []).length, publishedPosts().length)
})

test('RSS lastBuildDate sits on the channel, never inside an item', () => {
  const xml = buildRssFeed()
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? []
  assert.ok(itemBlocks.length > 0, 'feed has no items')
  for (const item of itemBlocks) {
    assert.ok(!item.includes('lastBuildDate'), 'item must not carry lastBuildDate')
  }
  const channelHead = xml.slice(0, xml.indexOf('<item>'))
  assert.match(
    channelHead,
    /<lastBuildDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} 00:00:00 GMT<\/lastBuildDate>/,
    'channel must carry an RFC-822 lastBuildDate',
  )
})

test('JSON-LD emits BlogPosting per post and Blog for the index', () => {
  const [first] = publishedPosts()
  const jsonLd = blogPostJsonLd(first)
  assert.equal(jsonLd['@context'], 'https://schema.org')
  assert.equal(jsonLd['@type'], 'BlogPosting')
  assert.equal(jsonLd.headline, first.data.title)
  assert.equal(jsonLd.datePublished, first.data.date)
  assert.equal(jsonLd.inLanguage, 'en-GB')
  const index = blogIndexJsonLd()
  assert.equal(index['@type'], 'Blog')
  assert.equal((index.blogPost as unknown[]).length, publishedPosts().length)
})

test('jsonLdScript escapes "<" so no value can close the script element', () => {
  const payload = { headline: 'a <script>alert(1)</script> tail', url: 'https://hitly.net/blog/x' }
  const serialized = jsonLdScript(payload)
  assert.ok(!serialized.includes('<'), 'raw < must not survive serialization')
  assert.ok(serialized.includes('\\u003c'), 'expected < escaping')
  assert.deepEqual(JSON.parse(serialized), payload)
  // Both blog routes must serialize their JSON-LD through it.
  const index = readFileSync(join(WEB_ROOT, 'app', 'blog', 'page.tsx'), 'utf8')
  const post = readFileSync(join(WEB_ROOT, 'app', 'blog', '[slug]', 'page.tsx'), 'utf8')
  assert.match(index, /jsonLdScript\(blogIndexJsonLd\(\)\)/)
  assert.match(post, /jsonLdScript\(blogPostJsonLd\(page\)\)/)
})

test('blogPostMeta provides canonical, OG article, and twitter metadata', () => {
  const [first] = publishedPosts()
  const meta = blogPostMeta(first)
  assert.equal(meta.alternates?.canonical, postUrl(first))
  assert.equal(meta.openGraph?.type, 'article')
  assert.equal(meta.twitter?.card, 'summary')
  assert.ok(meta.openGraph?.title?.toString().endsWith('— HITLy'))
})

test('blog routes are pinned to the marketing chrome and disclaimer', () => {
  const index = readFileSync(join(WEB_ROOT, 'app', 'blog', 'page.tsx'), 'utf8')
  assert.match(index, /SiteHeader/)
  assert.match(index, /SiteFooter/)
  assert.match(index, /marketingMeta/)
  assert.match(index, /blogIndexJsonLd/)
  assert.match(index, /application\/rss\+xml/, 'index must advertise the feed')
  assert.match(index, /BlogDisclaimer/)

  const post = readFileSync(join(WEB_ROOT, 'app', 'blog', '[slug]', 'page.tsx'), 'utf8')
  assert.match(post, /SiteHeader/)
  assert.match(post, /SiteFooter/)
  assert.match(post, /getMDXComponents/)
  assert.match(post, /blogPostJsonLd/)
  assert.match(post, /blogPostMeta/)
  assert.match(post, /BlogDisclaimer/)
  assert.match(post, /notFound\(\)/, 'draft posts must 404')

  const feedRoute = readFileSync(join(WEB_ROOT, 'app', 'blog', 'feed.xml', 'route.ts'), 'utf8')
  assert.match(feedRoute, /application\/rss\+xml/)
  assert.match(feedRoute, /buildRssFeed/)
})

test('feed route serves the RSS body with the right content type', async () => {
  const { GET } = await import('@/app/blog/feed.xml/route')
  const response = GET()
  assert.equal(response.headers.get('content-type'), 'application/rss+xml; charset=utf-8')
  const body = await response.text()
  assert.equal(body, buildRssFeed())
})

test('blog:new scaffolds a draft-safe post, refuses overwrite, then cleans up', () => {
  const script = join(REPO_ROOT, 'scripts', 'new-blog-post.mjs')
  const title = 'Temporary Scaffold Check'
  const file = join(BLOG_DIR, 'temporary-scaffold-check.mdx')
  try {
    execFileSync('node', [script, title, '--draft'], { cwd: WEB_ROOT, stdio: 'pipe' })
    assert.ok(existsSync(file), 'scaffold did not write the file')
    const raw = readFileSync(file, 'utf8')
    assert.match(raw, /^title: "Temporary Scaffold Check"$/m)
    assert.match(raw, /^draft: true$/m)
    assert.match(raw, /^date: \d{4}-\d{2}-\d{2}$/m)
    // Overwrite must fail loudly.
    assert.throws(() => execFileSync('node', [script, title], { cwd: WEB_ROOT, stdio: 'pipe' }))
    // Empty slug from a punctuation-only title must fail.
    assert.throws(() => execFileSync('node', [script, '!!!'], { cwd: WEB_ROOT, stdio: 'pipe' }))
  } finally {
    rmSync(file, { force: true })
  }
  assert.ok(!existsSync(file))
})
