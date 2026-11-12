'use client'

import { useState, type FormEvent } from 'react'
import { RESEND_VERIFICATION_SUCCEEDED_MESSAGE, submitResendEmailVerification } from '@/lib/email-verification'

/**
 * Unverified badge and signed-in resend, shown on the account profile and
 * the security page. Hidden once the address is verified. The success copy
 * matches the generic server body: it does not say whether a mail went out.
 */
export function UnverifiedEmailNotice({ verified }: { verified: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

  if (verified) return null

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const outcome = await submitResendEmailVerification()
    if (outcome.ok) {
      setDone(true)
    } else {
      setError(outcome.message)
    }
    setPending(false)
  }

  return (
    <div className="mt-3 flex max-w-md flex-col gap-3">
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        <span className="mr-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Unverified
        </span>
        This email address is not verified yet. You can keep using HITLy.
      </p>
      {done ? (
        <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
          {RESEND_VERIFICATION_SUCCEEDED_MESSAGE}
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            className="h-10 self-start rounded-md border border-zinc-300 px-3 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
          >
            Resend verification email
          </button>
        </form>
      )}
    </div>
  )
}
