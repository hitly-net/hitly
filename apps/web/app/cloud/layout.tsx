import Script from 'next/script'
import type { ReactNode } from 'react'

export default function CloudLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Script
        src="https://click.hitly.net/js/script.js"
        data-domain="cloud.hitly.net"
        strategy="afterInteractive"
      />
      {children}
    </>
  )
}
