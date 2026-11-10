'use client'

import { useState, type FormEvent } from 'react'
import { CHANGE_EMAIL_SUCCEEDED_MESSAGE, submitEmailChange } from '@/lib/email-change'

const INPUT_CLASS =
  'h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900'

/**
 * The security page's change-email form: the signed-in user must give the
 * current password, and a confirmation link is emailed to the new address.
 * The live account email is not updated until that link is used.
 */
export function ChangeEmailForm() {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

  if (done) {
    return (
      <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
        {CHANGE_EMAIL_SUCCEEDED_MESSAGE}
      </p>
    )
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const currentPassword = String(form.get('currentPassword') ?? '')
    const newEmail = String(form.get('newEmail') ?? '')
    setPending(true)
    setError(null)
    const outcome = await submitEmailChange(currentPassword, newEmail)
    if (outcome.ok) {
      setDone(true)
    } else {
      formElement.reset()
      setError(outcome.message)
    }
    setPending(false)
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-3">
      <input
        name="newEmail"
        type="email"
        required
        placeholder="New email"
        autoComplete="email"
        className={INPUT_CLASS}
      />
      <input
        name="currentPassword"
        type="password"
        required
        placeholder="Current password"
        autoComplete="current-password"
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
        Change email
      </button>
    </form>
  )
}
