import Link from 'next/link'
import { HitlyLockup, HitlyWordmark } from '@hitly/ui'

const links = [
  { href: '/docs', label: 'Docs' },
  { href: '/integrations', label: 'Integrations' },
]

export function SiteHeader() {
  return (
    <header className="border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80 md:sticky md:top-0 md:z-50">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="inline-flex">
          <HitlyLockup markClassName="h-8 w-8" wordmarkClassName="text-lg" />
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
              {link.label}
            </Link>
          ))}
          <Link
            href="/#waitlist"
            className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Join waitlist
          </Link>
        </nav>
      </div>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-zinc-200 py-10 dark:border-zinc-800">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 text-sm text-zinc-500">
        <p>
          <HitlyWordmark /> — human in the loop for agents & workflows.
        </p>
        <div className="flex gap-4">
          <Link href="/docs">Docs</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </div>
      </div>
    </footer>
  )
}
