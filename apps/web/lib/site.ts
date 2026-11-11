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

export function buildRobots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
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
    // Per-page twitter:title (soft S3): without this the card on every
    // marketing leaf shows the layout-wide 'HITLy'.
    ...(options.title === undefined
      ? {}
      : { twitter: { card: 'summary' as const, title: `${options.title} — HITLy` } }),
  }
}

/** Canonical + OG + twitter metadata for a fumadocs page (docs or integrations). */
export function docPageMeta(page: {
  url: string
  data: { title: string; description?: string }
}): Metadata {
  const url = absoluteUrl(page.url.replace(/\/$/, ''))
  // A page titled 'HITLy' (the /docs index) must not be rendered as
  // 'HITLy — HITLy': the template would brand it twice (soft S4).
  const bare = page.data.title === 'HITLy'
  const pageTitle: Metadata['title'] = bare ? { absolute: 'HITLy' } : page.data.title
  const ogTitle = bare ? 'HITLy' : `${page.data.title} — HITLy`
  return {
    title: pageTitle,
    description: page.data.description,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      url,
      title: ogTitle,
      siteName: 'HITLy',
    },
    // Per-page twitter:title (soft S3).
    twitter: { card: 'summary', title: ogTitle },
  }
}
