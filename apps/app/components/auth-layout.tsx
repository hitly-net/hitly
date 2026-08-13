import Link from 'next/link'
import type { ReactNode } from 'react'
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
        <Link href={WEB_URL} className="text-lg font-semibold">
          Hitly
        </Link>
        <h1 className="mt-6 text-2xl font-semibold">{title}</h1>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  )
}
