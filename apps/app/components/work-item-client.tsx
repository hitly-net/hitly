'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import type { AllowedActions, Decision } from '@hitly/core'
import { decideWorkItem } from '@/actions/projects'

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

export function WorkItemDecideForm({
  approvalId,
  returnTo,
  allowed,
  initialEditedArgs,
}: {
  approvalId: string
  returnTo: string
  allowed: AllowedActions
  initialEditedArgs: string
}) {
  const [editedArgs, setEditedArgs] = useState(initialEditedArgs)
  const [response, setResponse] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const allowEdit = Boolean(allowed.edit)
  const allowRespond = Boolean(allowed.respond)
  const decisions = (Object.entries(allowed) as [Decision, boolean][])
    .filter(([, on]) => on)
    .map(([decision]) => decision)

  function submit(decision: Decision) {
    setError(null)
    startTransition(async () => {
      try {
        await decideWorkItem(approvalId, {
          decision,
          returnTo,
          response: allowRespond ? response : undefined,
          editedArgsJson: allowEdit ? editedArgs : undefined,
        })
      } catch (err) {
        // Next.js redirect() throws; ignore redirect digests.
        if (err && typeof err === 'object' && 'digest' in err && String(err.digest).startsWith('NEXT_REDIRECT')) {
          return
        }
        setError(err instanceof Error ? err.message : 'Decision failed')
      }
    })
  }

  return (
    <div className="mt-6 flex max-w-xl flex-col gap-3">
      {allowEdit ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Edited args</span>
          <span className="text-xs text-zinc-500">Change a value, then click Edit.</span>
          <textarea
            value={editedArgs}
            onChange={(event) => setEditedArgs(event.target.value)}
            className="min-h-24 rounded-md border border-zinc-200 px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
      ) : null}
      {allowRespond ? (
        <input
          value={response}
          onChange={(event) => setResponse(event.target.value)}
          placeholder="Response"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      ) : null}
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {decisions.map((decision) => (
          <button
            key={decision}
            type="button"
            disabled={pending}
            onClick={() => submit(decision)}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium capitalize text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {decision}
          </button>
        ))}
      </div>
    </div>
  )
}
