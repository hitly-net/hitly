'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useFormStatus } from 'react-dom'
import type { AllowedActions, Decision } from '@hitly/core'

/**
 * Records `presented` (hitl-spec 5.2): the ask was FIRST shown to this
 * reviewer, who can decide. Explicit POST from a client component only
 * rendered when the reviewer can act, so Next prefetch, RefreshOnFocus
 * re-renders and polling are never counted as "shown". Fires once per mount;
 * the endpoint is idempotent. Never blocks rendering; errors are swallowed.
 */
export function MarkPresented({ approvalId }: { approvalId: string }) {
  const sentRef = useRef(false)
  useEffect(() => {
    if (sentRef.current) return
    sentRef.current = true
    fetch(`/api/v1/approvals/${approvalId}/presented`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
      .then((response) => {
        if (!response.ok) console.warn('[hitly] mark presented failed', response.status)
      })
      .catch((error) => {
        console.warn('[hitly] mark presented failed', error)
      })
  }, [approvalId])
  return null
}

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
