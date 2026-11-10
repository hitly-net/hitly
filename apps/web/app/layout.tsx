import { RootProvider } from 'fumadocs-ui/provider/next'
import { Geist, Geist_Mono } from 'next/font/google'
import { headers } from 'next/headers'
import Script from 'next/script'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { isCloudHost } from '@/lib/host'
import { SITE_URL } from '@/lib/site'
import './globals.css'

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-sans',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
})

const DESCRIPTION =
  'HITLy is the approval inbox for agent work. Mastra, Hermes, HTTP, LangGraph, and Temporal origins pause; reviewers decide in HITLy; plugins resume the run.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'HITLy',
    template: '%s — HITLy',
  },
  description: DESCRIPTION,
  openGraph: {
    type: 'website',
    siteName: 'HITLy',
    url: `${SITE_URL}/`,
    title: 'HITLy',
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary',
    title: 'HITLy',
    description: DESCRIPTION,
  },
}

export default async function Layout({ children }: { children: ReactNode }) {
  const headersList = await headers()
  const host = headersList.get('host')
  const dataDomain = isCloudHost(host) ? 'cloud.hitly.net' : 'hitly.net'

  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans">
        <Script
          src="https://click.hitly.net/js/script.js"
          data-domain={dataDomain}
          strategy="afterInteractive"
        />
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}
