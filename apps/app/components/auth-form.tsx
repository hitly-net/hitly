'use client'

import { useState, type FormEvent } from 'react'

export function AuthForm({
  action,
  submitLabel,
  extraFields,
  redirectTo,
  fixedEmail,
}: {
  action: '/api/auth/sign-in/email' | '/api/auth/sign-up/email'
  submitLabel: string
  extraFields?: 'name'
  /** Same-site path to open after success (defaults: /inbox after sign-up, / after sign-in). */
  redirectTo?: string
  /** Pre-fills the email and makes it read-only. */
  fixedEmail?: string
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const form = new FormData(event.currentTarget)
    const body = Object.fromEntries(form.entries())
    try {
      const response = await fetch(action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
      })
      const data = (await response.json().catch(() => ({}))) as { message?: string; mfaRequired?: boolean }
      if (!response.ok) {
        setError(data.message ?? 'Something went wrong')
        setPending(false)
        return
      }
      if (data.mfaRequired) {
        window.location.href = '/login/mfa'
        return
      }
      const redirectPath =
        redirectTo && redirectTo.startsWith('/') && !redirectTo.startsWith('//')
          ? redirectTo
          : action.includes('sign-up')
            ? '/inbox'
            : '/'
      window.location.href = redirectPath
    } catch {
      setError('Something went wrong')
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {extraFields === 'name' ? (
        <input name="name" required placeholder="Name" autoComplete="name" className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
      ) : null}
      <input
        name="email"
        type="email"
        required
        placeholder="Email"
        autoComplete="username"
        defaultValue={fixedEmail}
        readOnly={fixedEmail !== undefined}
        className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
      <input
        name="password"
        type="password"
        required
        minLength={8}
        placeholder="Password"
        autoComplete={action.includes('sign-up') ? 'new-password' : 'current-password'}
        className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
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
