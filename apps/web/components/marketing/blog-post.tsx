import Link from 'next/link'
import { BLOG_DISCLAIMER, formatPostDate } from '@/lib/blog'
import { publishedPosts } from '@/lib/source'

/** Shared by the blog index and post pages so the wording never drifts. */
export function BlogDisclaimer() {
  return (
    <aside
      role="note"
      className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm leading-6 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
    >
      {BLOG_DISCLAIMER}
    </aside>
  )
}

export function PostList() {
  const posts = publishedPosts()
  if (posts.length === 0) {
    return <p className="text-zinc-500">No posts yet — check back soon.</p>
  }
  return (
    <ol className="flex flex-col gap-10">
      {posts.map((post) => (
        <li key={post.url}>
          <article>
            <Link
              href={post.url.replace(/\/$/, '')}
              className="text-xl font-semibold text-zinc-900 hover:underline dark:text-zinc-50"
            >
              {post.data.title}
            </Link>
            <p className="mt-1 text-sm text-zinc-500">
              <time dateTime={post.data.date}>{formatPostDate(post.data.date)}</time>
            </p>
            <p className="mt-2 leading-7 text-zinc-600 dark:text-zinc-400">{post.data.description}</p>
            <a
              href={post.url.replace(/\/$/, '')}
              className="mt-2 inline-block text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-50"
            >
              Read the post
            </a>
          </article>
        </li>
      ))}
    </ol>
  )
}
