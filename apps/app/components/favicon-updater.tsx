'use client'

import { useEffect } from 'react'

export function FaviconUpdater() {
  useEffect(() => {
    let timeoutId: NodeJS.Timeout

    async function updateFavicon() {
      try {
        const response = await fetch('/api/v1/inbox/summary')
        if (!response.ok) return
        
        const summary = await response.json() as {
          pending: number
          failedResume: number
          decidedToday: number
          projectCount: number
        }

        const hasOpenItems = (summary.pending + summary.failedResume) > 0
        const iconPath = hasOpenItems ? '/icon-open.svg' : '/icon.svg'

        const link = document.querySelector<HTMLLinkElement>("link[rel*='icon']") 
          || document.createElement('link')
        link.type = 'image/svg+xml'
        link.rel = 'icon'
        link.href = iconPath

        if (!link.parentNode) {
          document.head.appendChild(link)
        }
      } catch {
        // TODO: Wire to real-time inbox updates when available
        // Silently fail for now - keep existing favicon
      }
    }

    function scheduleUpdate() {
      updateFavicon()
      timeoutId = setTimeout(scheduleUpdate, 30000) // Poll every 30s
    }

    scheduleUpdate()

    return () => {
      clearTimeout(timeoutId)
    }
  }, [])

  return null
}
