'use client'

import { useState, type FormEvent } from 'react'

export function AuthForm({
  action,
  submitLabel,
  extraFields,
}: {
  action: '/api/auth/sign-in/email' | '/api/auth/sign-up/email' | '/api/auth/forget-password' | '/api/auth/reset-password'
  submitLabel: string
  extraFields?: 'name' | 'token'
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const form = new FormData(event.currentTarget)
    const body = Object.fromEntries(form.entries())
    const response = await fetch(action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { message?: string }
      setError(data.message ?? 'Something went wrong')
      setPending(false)
      return
    }
    window.location.href = extraFields === 'token' || action.includes('forget') ? '/login' : '/'
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {extraFields === 'name' ? (
        <input name="name" required placeholder="Name" className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
      ) : null}
      {action.includes('reset-password') ? (
        <input name="token" required placeholder="Reset token" className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
      ) : (
        <input name="email" type="email" required placeholder="Email" className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
      )}
      {action.includes('forget-password') ? null : (
        <input
          name="password"
          type="password"
          required
          minLength={8}
          placeholder="Password"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      )}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {submitLabel}
      </button>
    </form>
  )
}
