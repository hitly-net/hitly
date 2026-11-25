import type { Metadata } from 'next'
import { publishedPosts, type BlogPost } from '@/lib/source'
import { SITE_URL, absoluteUrl } from '@/lib/site'

/** Absolute URL of the blog index. */
export const BLOG_INDEX_PATH = '/blog'

/** Canonical absolute URL of the RSS feed (also advertised via <link rel="alternate">). */
export const FEED_PATH = '/blog/feed.xml'

/**
 * Single source of truth for the regulatory disclaimer shown on the blog
 * index and every post. Requirements: state that HITLy is a technology
 * provider, not FCA-authorised, not a law firm; make no compliance claims.
 * ™ only — the registered mark (®) belongs solely to the legal-notice page.
 */
export const BLOG_DISCLAIMER =
  'HITLy™ is a technology provider. It is not authorised or regulated by the Financial Conduct Authority, it is not a law firm, and nothing on this page is legal or regulatory advice. HITLy does not assess whether any product, agent, or workflow complies with any regulation. Speak to your own regulatory and legal advisers.'

/** Frontmatter dates are ISO (YYYY-MM-DD, UTC); RSS/Atom need an RFC-822 GMT string. */
export function toRfc822(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ISO date: ${isoDate}`)
  return date.toUTCString()
}

/** Human-readable date for the page chrome, e.g. "25 November 2026". */
export function formatPostDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ISO date: ${isoDate}`)
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Effective modification date: `updated` when set, else `date`. */
export function postModified(post: Pick<BlogPost['data'], 'date' | 'updated'>): string {
  return post.updated ?? post.date
}

export function postUrl(post: Pick<BlogPost, 'url'>): string {
  return absoluteUrl(post.url.replace(/\/$/, ''))
}

/**
 * RSS 2.0 feed for published posts. Hand-rolled (no feed dependency): the
 * corpus is a handful of posts and the shape is small enough to pin in
 * tests. Items carry title, link, guid (permalink), description, dates.
 */
export function buildRssFeed(): string {
  const items = publishedPosts()
    .map((post) => {
      const link = postUrl(post)
      return [
        '    <item>',
        `      <title>${escapeXml(post.data.title)}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
        `      <description>${escapeXml(post.data.description)}</description>`,
        `      <pubDate>${escapeXml(toRfc822(post.data.date))}</pubDate>`,
        `      <lastBuildDate>${escapeXml(toRfc822(postModified(post.data)))}</lastBuildDate>`,
        '    </item>',
      ].join('\n')
    })
    .join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>HITLy™ Blog</title>',
    `    <link>${escapeXml(absoluteUrl(BLOG_INDEX_PATH))}</link>`,
    '    <description>Notes from the HITLy™ team on human oversight for AI agents: approvals, audit trails, and the regulators watching agentic AI.</description>',
    '    <language>en-gb</language>',
    `    <atom:link href="${escapeXml(absoluteUrl(FEED_PATH))}" rel="self" type="application/rss+xml"/>`,
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n')
}

const PUBLISHER = {
  '@type': 'Organization',
  name: 'HITLy',
  url: SITE_URL,
} as const

/** Schema.org BlogPosting for one post (rendered as a JSON-LD script tag). */
export function blogPostJsonLd(post: BlogPost): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.data.title,
    description: post.data.description,
    inLanguage: 'en-GB',
    datePublished: post.data.date,
    dateModified: postModified(post.data),
    author: PUBLISHER,
    publisher: PUBLISHER,
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': postUrl(post),
    },
  }
}

/** Schema.org Blog for the /blog index page. */
export function blogIndexJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'HITLy Blog',
    url: absoluteUrl(BLOG_INDEX_PATH),
    inLanguage: 'en-GB',
    publisher: PUBLISHER,
    blogPost: publishedPosts().map((post) => ({
      '@type': 'BlogPosting',
      headline: post.data.title,
      url: postUrl(post),
      datePublished: post.data.date,
    })),
  }
}

/** Article metadata for a single post page (canonical, OG article, twitter). */
export function blogPostMeta(post: BlogPost): Metadata {
  const url = postUrl(post)
  const ogTitle = `${post.data.title} — HITLy`
  return {
    title: post.data.title,
    description: post.data.description,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      url,
      title: ogTitle,
      description: post.data.description,
      siteName: 'HITLy',
      publishedTime: post.data.date,
      modifiedTime: postModified(post.data),
    },
    twitter: { card: 'summary', title: ogTitle, description: post.data.description },
  }
}
