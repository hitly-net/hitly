'use client'

import { useState, type FormEvent } from 'react'
import { RESEND_VERIFICATION_SUCCEEDED_MESSAGE, submitResendEmailVerification } from '@/lib/email-verification'

/**
 * Top-of-app banner shown while the verified-email gate is on and the
 * signed-in address is not yet verified (AppShell decides visibility via
 * shouldShowUnverifiedEmailBanner). It names what the gate holds — creating
 * projects and API keys, and notifications — and offers the SAME rate-limited
 * signed-in resend flow as the settings notice (POST /api/session/
 * resend-email-verification). Success copy matches the generic server body:
 * it does not say whether a mail went out.
 */
export function UnverifiedEmailBanner() {
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
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
      data-testid="unverified-email-banner"
    >
      <p>
        <span className="font-medium">Email not verified.</span> Verify your
        address to create projects and API keys and to receive notifications.
      </p>
      {done ? (
        <p className="text-sm">{RESEND_VERIFICATION_SUCCEEDED_MESSAGE}</p>
      ) : (
        <form onSubmit={onSubmit} className="flex items-center gap-3">
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
