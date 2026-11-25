import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { BlogDisclaimer, PostList } from '@/components/marketing/blog-post'
import { blogIndexJsonLd, BLOG_INDEX_PATH } from '@/lib/blog'
import { absoluteUrl, marketingMeta } from '@/lib/site'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  ...marketingMeta({
    title: 'Blog',
    description:
      'Notes from the HITLy™ team on human oversight for AI agents: approvals, audit trails, and the regulators watching agentic AI.',
    path: BLOG_INDEX_PATH,
  }),
  alternates: {
    canonical: absoluteUrl(BLOG_INDEX_PATH),
    types: { 'application/rss+xml': absoluteUrl('/blog/feed.xml') },
  },
}

export default function BlogIndexPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-16">
        <header>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">Blog</h1>
          <p className="mt-3 leading-7 text-zinc-600 dark:text-zinc-400">
            Notes from the HITLy™ team on human oversight for AI agents: approvals, audit trails,
            and the regulators watching agentic AI. Subscribe via{' '}
            <a href="/blog/feed.xml" className="underline hover:text-zinc-900 dark:hover:text-zinc-50">
              RSS
            </a>
            .
          </p>
        </header>
        <PostList />
        <BlogDisclaimer />
      </main>
      <SiteFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogIndexJsonLd()) }}
      />
    </>
  )
}
