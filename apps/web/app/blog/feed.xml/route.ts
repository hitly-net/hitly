import { buildRssFeed } from '@/lib/blog'

export const revalidate = false

export function GET() {
  return new Response(buildRssFeed(), {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'public, max-age=3600, s-maxage=86400',
    },
  })
}
