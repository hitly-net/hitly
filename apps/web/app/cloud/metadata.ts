import { marketingMeta } from '@/lib/site'

/**
 * Page-local metadata for /cloud (kept free of component imports so the
 * discovery test can pin it directly).
 *
 * - `noindex, nofollow` (the page is a sign-in placeholder, not marketing).
 * - Its OWN OpenGraph/twitter block (soft S2): without it a share of /cloud
 *   inherits the homepage og:url/og:title and advertises `https://hitly.net`
 *   instead of the page that was actually shared.
 */
export const cloudMetadata = {
  ...marketingMeta({
    title: 'Cloud',
    description: 'Sign in to HITLy Cloud to review and decide agent actions.',
    path: '/cloud',
  }),
  robots: { index: false, follow: false },
}
