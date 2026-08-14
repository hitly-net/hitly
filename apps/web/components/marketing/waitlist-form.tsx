'use client'

import { useState, type FormEvent } from 'react'
import { Button } from '@hitly/ui'
import { WAITLIST_INTEGRATIONS, type WaitlistIntegration } from '@/lib/waitlist'

const LABELS: Record<WaitlistIntegration, string> = {
  mastra: 'Mastra',
  langgraph: 'LangGraph',
  n8n: 'n8n',
}

export function WaitlistForm() {
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
        setError(body?.error ?? 'Could not join the waitlist. Try again.')
        return
      }
      setStatus('success')
    } catch {
      setStatus('error')
      setError('Could not join the waitlist. Try again.')
    }
  }

  if (status === 'success') {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950" role="status">
        <p className="text-sm font-medium uppercase tracking-widest text-zinc-500">You are on the list</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight">Thank you</h2>
        <p className="mt-3 text-zinc-600 dark:text-zinc-400">
          We will email you when HITLy is ready for {name.trim() || 'you'}.
        </p>
      </div>
    )
  }

  return (
    <form
      id="waitlist"
      onSubmit={onSubmit}
      className="rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <p className="text-sm font-medium uppercase tracking-widest text-zinc-500">Waitlist</p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">Get early access</h2>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Tell us how you orchestrate agents. We will write when the inbox is open.
      </p>

      <label className="mt-6 block text-sm font-medium">
        Name
        <input
          required
          name="name"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-1.5 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-500"
        />
      </label>

      <label className="mt-4 block text-sm font-medium">
        Email
        <input
          required
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1.5 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-500"
        />
      </label>

      <fieldset className="mt-5">
        <legend className="text-sm font-medium">System integration</legend>
        <div className="mt-2 space-y-2">
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
              onChange={(event) => setOtherChecked(event.target.checked)}
              className="size-4 rounded border-zinc-300"
            />
            Other
          </label>
          {otherChecked ? (
            <input
              name="other"
              value={other}
              onChange={(event) => setOther(event.target.value)}
              placeholder="Which system?"
              className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-500"
            />
          ) : null}
        </div>
      </fieldset>

      {error ? <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p> : null}

      <Button type="submit" className="mt-6 w-full" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Joining…' : 'Join the waitlist'}
      </Button>
    </form>
  )
}
