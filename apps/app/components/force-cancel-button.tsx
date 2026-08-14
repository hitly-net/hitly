'use client'

import { EllipsisVertical } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cancelWorkItem } from '@/actions/projects'

export function ForceCancelButton({ approvalId }: { approvalId: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function onForceCancel() {
    setOpen(false)
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
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <EllipsisVertical className="h-5 w-5" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-40 rounded-md border border-zinc-200 bg-white py-1 shadow-md dark:border-zinc-800 dark:bg-zinc-950"
        >
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void onForceCancel()}
            className="w-full px-3 py-2 text-left text-sm font-medium text-red-700 hover:bg-zinc-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-zinc-900"
          >
            {busy ? 'Cancelling…' : 'Force cancel'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
