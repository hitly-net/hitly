import Link from 'next/link'
import type { ReactNode } from 'react'
import { CloudMark } from '@hitly/cloud/brand'
import { HitlyWordmark } from '@hitly/ui'
import { WEB_URL } from '@/lib/constants'

export function AuthLayout({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link href={WEB_URL} className="inline-flex items-center gap-1.5 text-lg">
          <HitlyWordmark className="text-lg" />
          <CloudMark className="h-4 w-4" />
        </Link>
        <h1 className="mt-6 text-2xl font-semibold">{title}</h1>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  )
}
