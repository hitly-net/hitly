'use client'

import Link from 'next/link'
import { useCallback, useSyncExternalStore } from 'react'
import {
  BookOpen,
  Building2,
  ClipboardList,
  CreditCard,
  FolderKanban,
  Home,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { EditionNavItem } from '@hitly/core'
import { CloudMark } from '@hitly/cloud/brand'
import { HitlyWordmark } from '@hitly/ui'
import { WEB_URL } from '@/lib/constants'

const COOKIE = 'hitly-sidebar-collapsed'

const NAV_ICONS: Record<string, LucideIcon> = {
  '/': Home,
  '/inbox': Inbox,
  '/projects': FolderKanban,
  '/audit': ClipboardList,
}

const FOOTER: { href: string; label: string; icon: LucideIcon; external?: boolean }[] = [
  { href: '/settings/workspace', label: 'Workspace', icon: Building2 },
  { href: '/settings/team', label: 'Team', icon: Users },
  { href: '/settings/billing', label: 'Billing', icon: CreditCard },
  { href: `${WEB_URL}/docs`, label: 'Docs', icon: BookOpen, external: true },
]

function setCollapsedCookie(collapsed: boolean) {
  document.cookie = `${COOKIE}=${collapsed ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`
}

function readCollapsedCookie() {
  return document.cookie.split('; ').includes(`${COOKIE}=1`)
}

const collapsedStore = {
  listeners: new Set<() => void>(),

  getSnapshot() {
    if (typeof document === 'undefined') return false
    return readCollapsedCookie()
  },

  subscribe(callback: () => void) {
    collapsedStore.listeners.add(callback)
    return () => collapsedStore.listeners.delete(callback)
  },

  notify() {
    collapsedStore.listeners.forEach((listener) => listener())
  },

  set(value: boolean) {
    setCollapsedCookie(value)
    collapsedStore.notify()
  },
}

export function AppSidebar({ nav }: { nav: EditionNavItem[] }) {
  const collapsed = useSyncExternalStore(
    collapsedStore.subscribe,
    collapsedStore.getSnapshot,
    () => false
  )

  const toggle = useCallback(() => {
    collapsedStore.set(!collapsed)
  }, [collapsed])

  return (
    <aside
      className={
        collapsed
          ? 'flex h-full w-14 shrink-0 flex-col items-center overflow-hidden border-r border-zinc-200 bg-white py-4 dark:border-zinc-800 dark:bg-zinc-950'
          : 'flex h-full w-56 shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950'
      }
    >
      <div className={collapsed ? 'flex flex-col items-center gap-3' : 'flex items-center justify-between gap-2'}>
        <Link href="/" className="text-lg font-semibold tracking-tight" title="HITLy">
          <span className="inline-flex items-center gap-1.5">
            <HitlyWordmark className={collapsed ? 'text-sm' : 'text-lg'} />
            {!collapsed && <CloudMark className="h-4 w-4" />}
          </span>
        </Link>
        <button
          type="button"
          onClick={toggle}
          className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900"
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>
      <nav className={collapsed ? 'mt-8 flex flex-col items-center gap-1' : 'mt-8 flex flex-col gap-1 text-sm'}>
        {nav.map((item) => {
          const Icon = NAV_ICONS[item.href] ?? FolderKanban
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={
                collapsed
                  ? 'rounded-md p-2 hover:bg-zinc-100 dark:hover:bg-zinc-900'
                  : 'flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-900'
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {collapsed ? <span className="sr-only">{item.label}</span> : item.label}
            </Link>
          )
        })}
      </nav>
      <div className={collapsed ? 'mt-auto flex flex-col items-center gap-1' : 'mt-auto flex flex-col gap-1'}>
        {FOOTER.map((item) => {
          const Icon = item.icon
          const className = collapsed
            ? 'rounded-md p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900'
            : 'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900'
          if (item.external) {
            return (
              <a key={item.href} href={item.href} title={item.label} className={className}>
                <Icon className="h-4 w-4 shrink-0" />
                {collapsed ? <span className="sr-only">{item.label}</span> : item.label}
              </a>
            )
          }
          return (
            <Link key={item.href} href={item.href} title={item.label} className={className}>
              <Icon className="h-4 w-4 shrink-0" />
              {collapsed ? <span className="sr-only">{item.label}</span> : item.label}
            </Link>
          )
        })}
      </div>
    </aside>
  )
}
