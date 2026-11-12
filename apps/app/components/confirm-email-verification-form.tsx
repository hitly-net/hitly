'use client'

import { useState, type FormEvent } from 'react'
import { EMAIL_VERIFIED_MESSAGE, submitEmailVerification } from '@/lib/email-verification'

/**
 * Confirm button for /verify-email. GET (and HEAD/prefetch) only render this
 * form; the token is sent in the JSON POST body, never consumed by rendering
 * the page.
 */
export function ConfirmEmailVerificationForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

  if (done) {
    return (
      <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
        {EMAIL_VERIFIED_MESSAGE}
      </p>
    )
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const outcome = await submitEmailVerification(token)
    if (outcome.ok) {
      setDone(true)
    } else {
      setError(outcome.message)
    }
    setPending(false)
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-3">
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
        Confirm
      </button>
    </form>
  )
}
