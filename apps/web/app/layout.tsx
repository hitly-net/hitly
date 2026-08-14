import { RootProvider } from 'fumadocs-ui/provider/next'
import { Geist, Geist_Mono } from 'next/font/google'
import type { ReactNode } from 'react'
import './globals.css'

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-sans',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
})

export const metadata = {
  title: {
    default: 'HITLy',
    template: '%s — HITLy',
  },
  description: 'Human-in-the-loop approvals for Mastra, n8n, LangGraph, and Temporal.',
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}
