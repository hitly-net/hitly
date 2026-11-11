import { test } from 'node:test'
import assert from 'node:assert/strict'

await import('./test/preload.mjs')

import type { MetadataRoute } from 'next'

type SitemapEntry = MetadataRoute.Sitemap[number]

const {
  buildRobots,
  buildSitemap,
  MARKETING_ROUTES,
  DISALLOWED_ROUTES,
  absoluteUrl,
  docsPaths,
  marketingMeta,
  docPageMeta,
} = await import('@/lib/site')
const robotsRoute = (await import('@/app/robots.ts')).default
const sitemapRoute = (await import('@/app/sitemap.ts')).default

const BANNED = [/cloud-test\.hitly\.net/, /\b10\.\d+\.\d+\.\d+\b/, /\b192\.168\.\d+\.\d+\b/, /\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b/]

// Hard-coded expectation: every entry must be present in robots.txt, so
// dropping or narrowing any single DISALLOWED_ROUTES entry fails the suite.
// Keep this list and DISALLOWED_ROUTES in lockstep (pinned below).
const EXPECTED_DISALLOWED = [
  '/api/',
  '/cloud',
  '/inbox',
  '/projects',
  '/settings',
  '/connections',
  '/audit',
  '/invite',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/verify-email-change',
]

test('robots allows public pages, disallows app/auth/API paths and names the sitemap', () => {
  const robots = robotsRoute()
  assert.deepEqual(robots, buildRobots())
  const rule = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules
  assert.equal(rule.userAgent, '*')
  assert.equal(rule.allow, '/')
  const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow ?? '']
  for (const privatePath of EXPECTED_DISALLOWED) {
    assert.ok(disallow.includes(privatePath), `robots must disallow ${privatePath}`)
  }
  assert.deepEqual(
    [...disallow].sort(),
    [...EXPECTED_DISALLOWED].sort(),
    'robots disallow list must be exactly the pinned set',
  )
  assert.deepEqual(
    [...DISALLOWED_ROUTES].sort(),
    [...EXPECTED_DISALLOWED].sort(),
    'DISALLOWED_ROUTES must stay in lockstep with the pinned expectation',
  )
  for (const publicPath of ['/', '/pricing', '/privacy', '/terms', '/docs', '/integrations']) {
    assert.ok(!disallow.includes(publicPath), `robots must not disallow public ${publicPath}`)
  }
  assert.equal(robots.sitemap, 'https://hitly.net/sitemap.xml')
})

test('sitemap route is generated and uses absolute https://hitly.net URLs', () => {
  const entries = sitemapRoute()
  assert.deepEqual(entries, buildSitemap())
  assert.ok(entries.length > 10, `expected docs + marketing entries, got ${entries.length}`)
  for (const entry of entries) {
    assert.match(entry.url, /^https:\/\/hitly\.net(\/[^/]+)*$/)
    assert.ok(!entry.url.endsWith('/'), `no trailing slash: ${entry.url}`)
  }
})

test('sitemap covers every marketing route and every fumadocs page', () => {
  const urls = new Set(buildSitemap().map((entry: SitemapEntry) => entry.url))
  for (const path of MARKETING_ROUTES) assert.ok(urls.has(absoluteUrl(path)), path)
  for (const path of docsPaths()) assert.ok(urls.has(absoluteUrl(path)), path)
})

test('sitemap is generated from the docs source (would include /docs/mcp once it lands)', () => {
  const paths = docsPaths()
  // Sanity: the generator sees all docs pages currently on main...
  assert.ok(paths.includes('/docs/api'))
  assert.ok(paths.includes('/docs/self-host'))
  assert.ok(paths.includes('/integrations/mastra'))
  // ...and /docs/mcp arrives via content/docs/mcp.mdx + meta.json (PR #131)
  // without any change to the sitemap generator.
  if (paths.includes('/docs/mcp')) {
    assert.ok(new Set(buildSitemap().map((e: SitemapEntry) => e.url)).has('https://hitly.net/docs/mcp'))
  }
})

test('sitemap exposes no internal hosts or private IPs', () => {
  const body = JSON.stringify(buildSitemap())
  for (const pattern of BANNED) assert.ok(!pattern.test(body), `forbidden match: ${pattern}`)
})

test('sitemap excludes private, cloud and app paths', () => {
  const urls = new Set(buildSitemap().map((entry: SitemapEntry) => entry.url))
  for (const privatePath of [
    '/cloud',
    '/api/search',
    '/api/waitlist',
    '/inbox',
    '/login',
    '/signup',
    '/settings',
    '/projects',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/verify-email-change',
  ]) {
    assert.ok(!urls.has(absoluteUrl(privatePath)), `sitemap must exclude ${privatePath}`)
  }
})

test('sitemap includes every docs and integrations page from source', () => {
  const urls = new Set(buildSitemap().map((entry: SitemapEntry) => entry.url))
  for (const path of docsPaths()) {
    assert.ok(urls.has(absoluteUrl(path)), `sitemap missing docs page ${path}`)
  }
})

// --- sitemap exclusions (soft S1) -----------------------------------------
// The generator builds from MARKETING_ROUTES + docs sources; nothing ever
// asserted that the APP surface stays out. These pins kill the "add /cloud
// (or an app route) to the list" mutant.
test('sitemap excludes app, auth and the noindexed /cloud surface', () => {
  const urls = new Set(buildSitemap().map((entry: SitemapEntry) => entry.url))
  for (const path of ['/cloud', '/api', '/api/v1/approvals', '/inbox', '/audit', '/login', '/signup', '/settings']) {
    assert.ok(!urls.has(absoluteUrl(path)), `must not be in the sitemap: ${path}`)
  }
  for (const route of MARKETING_ROUTES as readonly string[]) {
    assert.notEqual(route, '/cloud')
    assert.ok(!route.startsWith('/api'), `app route leaked into MARKETING_ROUTES: ${route}`)
    assert.ok(!route.startsWith('/inbox'), `app route leaked into MARKETING_ROUTES: ${route}`)
    assert.ok(!route.startsWith('/audit'), `app route leaked into MARKETING_ROUTES: ${route}`)
  }
})

// --- /cloud page metadata (softs S1 + S2) ---------------------------------
// /cloud is a sign-in placeholder: it must stay out of the index AND must
// not advertise the homepage og:url/title when shared.
test('/cloud is noindex,nofollow with page-local OG/twitter blocks', async () => {
  const { cloudMetadata } = await import('@/app/cloud/metadata.ts')
  assert.deepEqual(cloudMetadata.robots, { index: false, follow: false })
  assert.equal(cloudMetadata.alternates?.canonical, 'https://hitly.net/cloud')
  assert.notEqual(cloudMetadata.openGraph?.url, 'https://hitly.net')
  assert.equal(cloudMetadata.openGraph?.url, 'https://hitly.net/cloud')
  assert.equal(cloudMetadata.openGraph?.title, 'Cloud — HITLy')
  assert.equal(cloudMetadata.twitter?.title, 'Cloud — HITLy')
})

// --- per-page twitter titles + bare-brand docs index (softs S3 + S4) ------
test('marketing and docs pages carry per-page twitter:title', () => {
  const pricing = marketingMeta({ title: 'Pricing', description: 'd', path: '/pricing' })
  assert.equal(pricing.twitter?.card, 'summary')
  assert.equal(pricing.twitter?.title, 'Pricing — HITLy')
  const guide = docPageMeta({ url: '/docs/self-host', data: { title: 'Self-host', description: 'd' } })
  assert.equal(guide.twitter?.title, 'Self-host — HITLy')
  // A page whose title is already 'HITLy' (the /docs index) must not be
  // branded twice by the layout template.
  const docsIndex = docPageMeta({ url: '/docs', data: { title: 'HITLy', description: 'd' } })
  assert.deepEqual(docsIndex.title, { absolute: 'HITLy' })
  assert.equal(docsIndex.openGraph?.title, 'HITLy')
  assert.equal(docsIndex.twitter?.title, 'HITLy')
})
