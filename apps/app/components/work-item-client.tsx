'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { useFormStatus } from 'react-dom'
import type { AllowedActions, Decision } from '@hitly/core'

export function RefreshOnFocus() {
  const router = useRouter()
  useEffect(() => {
    function refresh() {
      if (document.visibilityState === 'visible') router.refresh()
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [router])
  return null
}

export function WorkItemDecisionButtons({ allowed }: { allowed: AllowedActions }) {
  const { pending } = useFormStatus()
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.entries(allowed) as [Decision, boolean][])
        .filter(([, on]) => on)
        .map(([decision]) => (
          <button
            key={decision}
            name="decision"
            value={decision}
            disabled={pending}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium capitalize text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {decision}
          </button>
        ))}
    </div>
  )
}
