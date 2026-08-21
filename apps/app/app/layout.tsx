import { Geist, Geist_Mono } from 'next/font/google'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import './globals.css'
import { FaviconUpdater } from '@/components/favicon-updater'
import { ThemeSync } from '@/components/theme-picker'
import { parseTheme, THEME_COOKIE } from '@/lib/theme'

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' })

export const metadata = {
  title: { default: 'HITLy', template: '%s — HITLy' },
  description: 'HITLy — approval inbox for agent work',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value)
  const htmlClass = [geist.variable, geistMono.variable, theme === 'dark' ? 'dark' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <html lang="en" className={htmlClass} suppressHydrationWarning>
      <body className="h-dvh overflow-hidden bg-zinc-50 font-sans text-zinc-950 antialiased dark:bg-zinc-950 dark:text-zinc-50">
        <ThemeSync />
        <FaviconUpdater />
        {children}
      </body>
    </html>
  )
}
