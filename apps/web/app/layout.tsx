import { RootProvider } from 'fumadocs-ui/provider/next'
import { Geist, Geist_Mono } from 'next/font/google'
import Script from 'next/script'
import { headers } from 'next/headers'
import type { ReactNode } from 'react'
import { CloudPlaceholder } from '@/components/marketing/cloud-placeholder'
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

function isCloudHost(host: string | null): boolean {
  if (!host) return false
  return host === 'cloud.hitly.net' || host === 'www.cloud.hitly.net'
}

export default async function Layout({ children }: { children: ReactNode }) {
  const headersList = await headers()
  const host = headersList.get('host')
  const showCloudPlaceholder = isCloudHost(host)

  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans">
        <Script
          src="https://click.hitly.net/js/script.js"
          data-domain="hitly.net"
          strategy="afterInteractive"
        />
        <RootProvider>
          {showCloudPlaceholder ? <CloudPlaceholder /> : children}
        </RootProvider>
      </body>
    </html>
  )
}
