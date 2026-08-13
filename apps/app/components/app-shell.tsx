import Link from 'next/link'
import type { ReactNode } from 'react'
import { edition } from '@hitly/cloud'
import { hasFeature } from '@hitly/core'
import { WEB_URL } from '@/lib/constants'

const entitlements = edition.entitlementsFor({ plan: 'self-hosted' })
const nav = edition.navItems.filter((item) => !item.feature || hasFeature(entitlements, item.feature))

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col border-r border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <Link href="/" className="text-lg font-semibold">
          Hitly
        </Link>
        <nav className="mt-8 flex flex-col gap-1 text-sm">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="rounded-md px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-900">
              {item.label}
            </Link>
          ))}
        </nav>
        <a href={`${WEB_URL}/docs`} className="mt-auto px-2 text-xs text-zinc-500 hover:text-zinc-900">
          Docs
        </a>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-zinc-200 px-6 dark:border-zinc-800">
          <p className="text-sm text-zinc-500">Workspace</p>
          <Link href="/settings/profile" className="text-sm">
            Account
          </Link>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  )
}
