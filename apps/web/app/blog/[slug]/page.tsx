import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getMDXComponents } from '@/components/mdx'
import { BlogDisclaimer } from '@/components/marketing/blog-post'
import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { blogPostJsonLd, blogPostMeta, formatPostDate } from '@/lib/blog'
import { blogSource, publishedPosts } from '@/lib/source'
import type { Metadata } from 'next'

export default async function BlogPostPage(props: { params: Promise<{ slug?: string }> }) {
  const params = await props.params
  const page = blogSource.getPage([params.slug ?? ''])
  if (!page || page.data.draft === true) notFound()

  const MDX = page.data.body

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-16">
        <header className="flex flex-col gap-2">
          <Link href="/blog" className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50">
            ← Blog
          </Link>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            {page.data.title}
          </h1>
          <p className="text-sm text-zinc-500">
            <time dateTime={page.data.date}>{formatPostDate(page.data.date)}</time>
            {page.data.updated ? (
              <>
                {' · updated '}
                <time dateTime={page.data.updated}>{formatPostDate(page.data.updated)}</time>
              </>
            ) : null}
          </p>
          {page.data.description ? (
            <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">{page.data.description}</p>
          ) : null}
        </header>
        <article className="text-[15px] leading-7 text-zinc-700 dark:text-zinc-300">
          <MDX components={getMDXComponents()} />
        </article>
        <BlogDisclaimer />
      </main>
      <SiteFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostJsonLd(page)) }}
      />
    </>
  )
}

export function generateStaticParams() {
  return publishedPosts().map((post) => ({ slug: post.slugs.join('/') }))
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string }>
}): Promise<Metadata> {
  const params = await props.params
  const page = blogSource.getPage([params.slug ?? ''])
  if (!page || page.data.draft === true) notFound()
  return blogPostMeta(page)
}
