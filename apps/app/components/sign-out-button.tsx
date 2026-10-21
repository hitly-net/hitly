'use client'

import { useState } from 'react'
import { performSignOut, SIGN_OUT_FAILURE_MESSAGE } from '@/lib/sign-out'

export function SignOutButton({ className }: { className?: string }) {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function onClick() {
    if (pending) return
    setPending(true)
    setFailure(null)
    try {
      const outcome = await performSignOut()
      if (outcome === 'redirected') {
        return // the page navigates to /login; keep the button disabled
      }
      setFailure(SIGN_OUT_FAILURE_MESSAGE)
    } catch (error) {
      // performSignOut normally resolves; never leave a thrown error silent.
      console.error('[hitly sign-out] Unexpected sign-out error:', error)
      setFailure(SIGN_OUT_FAILURE_MESSAGE)
    } finally {
      setPending(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        className={className ?? 'text-sm text-zinc-500 hover:text-zinc-900 disabled:opacity-50'}
        onClick={() => {
          void onClick()
        }}
      >
        Sign out
      </button>
      {failure ? (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {failure}
        </p>
      ) : null}
    </div>
  )
}
