import Link from 'next/link'
import { HitlyWordmark } from '@hitly/ui'
import {
  COMPANY_NUMBER,
  LEGAL_FOOTER_COMPANY_PREFIX,
  LEGAL_FOOTER_COMPANY_SUFFIX,
  SUPPORT_EMAIL,
} from '@/lib/legal'

/**
 * Legal footer links (Legal-approved legal notice). Every marketing page
 * carries the full set: all seven legal pages plus the support address.
 */
export const LEGAL_FOOTER_LINKS = [
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/aup', label: 'AUP' },
  { href: '/dpa', label: 'DPA' },
  { href: '/subprocessors', label: 'Subprocessors' },
  { href: '/account-deletion', label: 'Account deletion' },
  { href: '/legal', label: 'Legal notice' },
]

const links = [
  { href: '/docs', label: 'Docs' },
  { href: '/integrations', label: 'Integrations' },
]

export function SiteHeader() {
  return (
    <header className="border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80 md:sticky md:top-0 md:z-50">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="inline-flex">
          <HitlyWordmark className="text-lg" trademark />
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
        <div className="flex flex-col gap-1">
          <p>
            <HitlyWordmark trademark /> — approval inbox for agent work.
          </p>
          <p className="text-xs text-zinc-500">
            {LEGAL_FOOTER_COMPANY_PREFIX}{' '}
            <a
              href="https://find-and-update.company-information.service.gov.uk/company/13641200"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-zinc-900 dark:hover:text-zinc-50"
            >
              {COMPANY_NUMBER}
            </a>
            {LEGAL_FOOTER_COMPANY_SUFFIX}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {LEGAL_FOOTER_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="hover:text-zinc-900 dark:hover:text-zinc-50"
            >
              {link.label}
            </Link>
          ))}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="hover:text-zinc-900 dark:hover:text-zinc-50"
          >
            {SUPPORT_EMAIL}
          </a>
        </div>
      </div>
    </footer>
  )
}
