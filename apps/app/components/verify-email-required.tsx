'use client'

import { useState, type FormEvent } from 'react'
import { RESEND_VERIFICATION_SUCCEEDED_MESSAGE, submitResendEmailVerification } from '@/lib/email-verification'
import { EMAIL_NOT_VERIFIED_MESSAGE, VERIFY_TO_CONTINUE_TITLE } from '@/lib/verified-gate'

/**
 * The shared "Verify your email to continue" state shown in place of a
 * gate-blocked create (project, API key, invite send/resend). Server actions
 * return the typed GateBlockedResult for a blocked action, so this renders
 * instead of an error page, a 500 or a raw error id. The resend link reuses
 * the SAME rate-limited signed-in flow as the banner and the settings notice
 * (POST /api/session/resend-email-verification); success copy stays generic.
 */
export function VerifyEmailRequiredNotice({ message = EMAIL_NOT_VERIFIED_MESSAGE }: { message?: string }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

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
    <div
      role="status"
      className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
      data-testid="verify-email-required"
    >
      <p>
        <span className="font-medium">{VERIFY_TO_CONTINUE_TITLE}.</span> {message}
      </p>
      {done ? (
        <p className="mt-2 text-sm">{RESEND_VERIFICATION_SUCCEEDED_MESSAGE}</p>
      ) : (
        <form onSubmit={onSubmit} className="mt-2 flex items-center gap-3">
          {error ? (
            <span role="alert" className="text-sm text-red-700 dark:text-red-400">
              {error}
            </span>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            className="h-8 rounded-md border border-amber-300 px-3 text-sm font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:hover:bg-amber-900"
          >
            Resend verification email
          </button>
        </form>
      )}
    </div>
  )
}
