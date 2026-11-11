import { integrationsSource, source } from '@/lib/source'
import type { Metadata, MetadataRoute } from 'next'

/** Canonical public origin. Everything SEO-facing is built from this. */
export const SITE_URL = 'https://hitly.net'

/** Marketing routes that should appear in the sitemap, in nav order. */
export const MARKETING_ROUTES = ['/', '/pricing', '/terms', '/terms/billing', '/privacy'] as const

/** Relative URL → absolute https://hitly.net URL. */
export function absoluteUrl(path: string): string {
  const clean = path === '/' ? '' : path.replace(/\/$/, '')
  return `${SITE_URL}${clean}`
}

/**
 * Indexable docs/integration pages, straight from the fumadocs sources.
 * Generated from source so new pages (and their meta.json entries) are
 * picked up automatically with no manual list to keep in sync.
 */
export function docsPaths(): string[] {
  return [...source.getPages(), ...integrationsSource.getPages()].map((page) =>
    page.url.replace(/\/$/, ''),
  )
}

export function buildSitemap(): MetadataRoute.Sitemap {
  const urls = [...MARKETING_ROUTES, ...docsPaths()]
  return urls.map((path) => ({ url: absoluteUrl(path), changeFrequency: 'monthly' }))
}

/**
 * Paths kept out of crawlers: API endpoints, the not-yet-GA cloud
 * placeholder, and the self-hosted app's authenticated surfaces
 * (login, inbox, project/settings pages).
 */
export const DISALLOWED_ROUTES = [
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
] as const

export function buildRobots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: [...DISALLOWED_ROUTES] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}

/**
 * Shared metadata for marketing pages: absolute canonical URL plus basic
 * OpenGraph tags. metadataBase on the root layout makes Next resolve the
 * canonical/OG URLs against https://hitly.net.
 */
export function marketingMeta(options: {
  title?: string
  description: string
  path: string
}): Metadata {
  const url = absoluteUrl(options.path)
  return {
    ...(options.title === undefined ? {} : { title: options.title }),
    description: options.description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      url,
      ...(options.title === undefined
        ? {}
        : { title: `${options.title} — HITLy`, siteName: 'HITLy' }),
    },
  }
}

/** Canonical + OG metadata for a fumadocs page (docs or integrations). */
export function docPageMeta(page: {
  url: string
  data: { title: string; description?: string }
}): Metadata {
  const url = absoluteUrl(page.url.replace(/\/$/, ''))
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      url,
      title: `${page.data.title} — HITLy`,
      siteName: 'HITLy',
    },
  }
}
