import { buildSitemap } from '@/lib/site'

export const revalidate = false

export default function sitemap() {
  return buildSitemap()
}
