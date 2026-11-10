'use client'

import { useState, type FormEvent } from 'react'
import { MFA_CHALLENGE_REQUIRED_MESSAGE, MFA_FACTOR_FIELD_PLACEHOLDER, submitMfaVerify } from '@/lib/mfa'

const INPUT_CLASS =
  'h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900'

export function MfaVerifyForm() {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const code = String(new FormData(form).get('code') ?? '')
    setPending(true)
    setError(null)
    const outcome = await submitMfaVerify(code)
    if (!outcome.ok) {
      setError(outcome.message)
      setPending(false)
      return
    }
    window.location.href = '/'
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{MFA_CHALLENGE_REQUIRED_MESSAGE}</p>
      <input
        name="code"
        required
        autoComplete="one-time-code"
        placeholder={MFA_FACTOR_FIELD_PLACEHOLDER}
        className={INPUT_CLASS}
      />
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        Continue
      </button>
    </form>
  )
}
