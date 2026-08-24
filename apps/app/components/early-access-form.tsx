'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import type { WaitlistIntegration } from '@/lib/waitlist'

const WAITLIST_INTEGRATIONS: readonly WaitlistIntegration[] = ['mastra', 'langgraph', 'n8n']

const LABELS: Record<WaitlistIntegration, string> = {
  mastra: 'Mastra',
  langgraph: 'LangGraph',
  n8n: 'n8n',
}

export function EarlyAccessForm() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [integrations, setIntegrations] = useState<WaitlistIntegration[]>([])
  const [otherChecked, setOtherChecked] = useState(false)
  const [other, setOther] = useState('')
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  function toggleIntegration(id: WaitlistIntegration) {
    setIntegrations((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]))
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatus('submitting')
    setError(null)

    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          integrations,
          other: otherChecked ? other : '',
        }),
      })
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      if (!response.ok) {
        setStatus('error')
        setError(body?.error ?? 'Could not submit. Try again.')
        return
      }
      setStatus('success')
    } catch {
      setStatus('error')
      setError('Could not submit. Try again.')
    }
  }

  if (status === 'success') {
    return (
      <div className="w-full max-w-md">
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-xl font-semibold">Thank you</h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            We will email you when HITLy is ready for {name.trim() || 'you'}.
          </p>
          <Link
            href="/login"
            className="mt-4 inline-block text-sm font-medium text-zinc-900 hover:text-zinc-700 dark:text-zinc-100 dark:hover:text-zinc-300"
          >
            Already have an account? Log in
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full max-w-md">
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-xl font-semibold">Request early access</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          HITLy Cloud is invite-only. Tell us how you orchestrate agents and we will contact you.
        </p>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <input
            required
            name="name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <input
            required
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <fieldset className="mt-2">
            <legend className="mb-2 text-sm font-medium">System integration</legend>
            <div className="space-y-2">
              {WAITLIST_INTEGRATIONS.map((id) => (
                <label key={id} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                  <input
                    type="checkbox"
                    checked={integrations.includes(id)}
                    onChange={() => toggleIntegration(id)}
                    className="size-4 rounded border-zinc-300"
                  />
                  {LABELS[id]}
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={otherChecked}
                  onChange={(e) => setOtherChecked(e.target.checked)}
                  className="size-4 rounded border-zinc-300"
                />
                Other
              </label>
              {otherChecked ? (
                <input
                  name="other"
                  value={other}
                  onChange={(e) => setOther(e.target.value)}
                  placeholder="Which system?"
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
              ) : null}
            </div>
          </fieldset>
          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          <button
            type="submit"
            disabled={status === 'submitting'}
            className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {status === 'submitting' ? 'Submitting…' : 'Request access'}
          </button>
        </form>
        <p className="mt-4 text-sm text-zinc-500">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-zinc-900 hover:text-zinc-700 dark:text-zinc-100 dark:hover:text-zinc-300">
            Log in
          </Link>
        </p>
      </div>
    </div>
  )
}
