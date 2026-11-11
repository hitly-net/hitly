import { RootProvider } from 'fumadocs-ui/provider/next'
import { Geist, Geist_Mono } from 'next/font/google'
import Script from 'next/script'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { plausibleScript } from '@/lib/telemetry'
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

export default function Layout({ children }: { children: ReactNode }) {
  // Direct env access so Next inlines NEXT_PUBLIC_* at `yarn build`.
  const plausible = plausibleScript({
    HITLY_TELEMETRY: process.env.HITLY_TELEMETRY,
    NEXT_PUBLIC_PLAUSIBLE_DOMAIN: process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN,
    NEXT_PUBLIC_PLAUSIBLE_SRC: process.env.NEXT_PUBLIC_PLAUSIBLE_SRC,
  })

  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans">
        {plausible ? (
          <Script src={plausible.src} data-domain={plausible.domain} strategy="afterInteractive" />
        ) : null}
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}
