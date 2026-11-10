import { test } from 'node:test'
import assert from 'node:assert/strict'

await import('./test/preload.mjs')

import type { MetadataRoute } from 'next'

type SitemapEntry = MetadataRoute.Sitemap[number]

const { buildRobots, buildSitemap, MARKETING_ROUTES, absoluteUrl, docsPaths } = await import(
  '@/lib/site'
)
const robotsRoute = (await import('@/app/robots.ts')).default
const sitemapRoute = (await import('@/app/sitemap.ts')).default

const BANNED = [/cloud-test\.hitly\.net/, /\b10\.\d+\.\d+\.\d+\b/, /\b192\.168\.\d+\.\d+\b/, /\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b/]

test('robots route allows everything and points at the sitemap', () => {
  const robots = robotsRoute()
  assert.deepEqual(robots, buildRobots())
  assert.deepEqual(robots.rules, { userAgent: '*', allow: '/' })
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
