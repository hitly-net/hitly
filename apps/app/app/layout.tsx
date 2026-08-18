import { Geist, Geist_Mono } from 'next/font/google'
import type { ReactNode } from 'react'
import './globals.css'
import { FaviconUpdater } from '@/components/favicon-updater'

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' })

export const metadata = {
  title: { default: 'HITLy', template: '%s — HITLy' },
  description: 'HITLy — approval inbox for agent work',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="h-dvh overflow-hidden bg-zinc-50 font-sans text-zinc-950 antialiased dark:bg-zinc-950 dark:text-zinc-50">
        <FaviconUpdater />
        {children}
      </body>
    </html>
  )
}
