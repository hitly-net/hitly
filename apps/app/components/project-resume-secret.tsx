'use client'

import { useState } from 'react'
import { regenerateProjectResumeSecret } from '@/actions/projects'

export function ProjectResumeSecret({
  projectId,
  secret,
}: {
  projectId: string
  secret: string
}) {
  const [value, setValue] = useState(secret)
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState<'secret' | 'env' | null>(null)
  const [busy, setBusy] = useState(false)
  const [justRotated, setJustRotated] = useState(false)
  const prefix = value.slice(0, 16)

  async function copy(kind: 'secret' | 'env', text: string) {
    await navigator.clipboard.writeText(text)
    setCopied(kind)
    window.setTimeout(() => setCopied(null), 1500)
  }

  async function onRegenerate() {
    if (
      !window.confirm(
        'Regenerate this resume secret? Origins must update HITLY_RESUME_SECRET and restart. In-flight signed proofs will fail.',
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const next = await regenerateProjectResumeSecret(projectId)
      setValue(next)
      setShown(true)
      setJustRotated(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 max-w-xl">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 font-mono text-xs break-all">
          {shown ? value : `${prefix}…`}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => setShown((current) => !current)}
          className="shrink-0 text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-50 dark:hover:text-zinc-100"
        >
          {shown ? 'Hide' : 'Reveal'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void copy('secret', value)}
          className="shrink-0 text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-50 dark:hover:text-zinc-100"
        >
          {copied === 'secret' ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void copy('env', `HITLY_RESUME_SECRET=${value}`)}
          className="shrink-0 text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-50 dark:hover:text-zinc-100"
        >
          {copied === 'env' ? 'Copied' : 'Copy .env'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRegenerate()}
          className="shrink-0 text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-50 dark:hover:text-zinc-100"
        >
          {busy ? 'Working…' : 'Regenerate'}
        </button>
      </div>
      {justRotated ? (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 font-mono text-xs break-all dark:border-amber-900 dark:bg-amber-950">
          Copy now — the previous secret no longer works: {value}
        </p>
      ) : null}
    </div>
  )
}
