import { RootProvider } from 'fumadocs-ui/provider/next'
import { Geist, Geist_Mono } from 'next/font/google'
import Script from 'next/script'
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
  description: 'Approval inbox for agent work — Mastra, Hermes, HTTP, LangGraph, and Temporal.',
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans">
        <Script
          src="https://click.hitly.net/js/script.js"
          data-domain="hitly.net"
          strategy="afterInteractive"
        />
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}
