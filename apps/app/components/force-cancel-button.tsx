'use client'

import { useState } from 'react'
import { cancelWorkItem } from '@/actions/projects'

export function ForceCancelButton({ approvalId }: { approvalId: string }) {
  const [busy, setBusy] = useState(false)

  async function onClick() {
    if (
      !window.confirm(
        'Force cancel this work item without resuming the origin? Use this when the run is no longer suspended or cannot accept a decision.',
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await cancelWorkItem(approvalId)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void onClick()}
      className="text-sm text-red-700 underline disabled:opacity-50 dark:text-red-400"
    >
      {busy ? 'Cancelling…' : 'Force cancel'}
    </button>
  )
}
