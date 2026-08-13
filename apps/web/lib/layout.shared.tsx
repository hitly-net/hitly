import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'Hitly',
    },
    links: [
      { text: 'Docs', url: '/docs' },
      { text: 'Integrations', url: '/integrations' },
      { text: 'Pricing', url: '/pricing' },
      { text: 'Open app', url: APP_URL },
    ],
  }
}
