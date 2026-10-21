'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { requestPasswordReset } from '@/lib/password-reset'

export function ForgotPasswordForm() {
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const email = String(new FormData(event.currentTarget).get('email') ?? '')
    const outcome = await requestPasswordReset(email)
    if (outcome.kind === 'sent') setNotice(outcome.message)
    else setError(outcome.message)
    setPending(false)
  }

  if (notice) {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
          {notice}
        </p>
        <Link href="/login" className="text-sm text-zinc-500 underline">
          Back to log in
        </Link>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <input
        name="email"
        type="email"
        required
        placeholder="Email"
        autoComplete="username"
        className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        Send reset link
      </button>
    </form>
  )
}
