import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { HitlyLockup } from '@hitly/ui'

export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <HitlyLockup markClassName="h-7 w-7" wordmarkClassName="text-base" />,
    },
  }
}
