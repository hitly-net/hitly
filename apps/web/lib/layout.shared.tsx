import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { HitlyWordmark } from '@hitly/ui'

export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <HitlyWordmark className="text-base" trademark />,
    },
  }
}
