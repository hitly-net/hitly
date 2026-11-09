'use client'

import { useState, type FormEvent } from 'react'
import {
  CHANGE_PASSWORD_SUCCEEDED_MESSAGE,
  submitPasswordChange,
} from '@/lib/password-change'
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_MISMATCH_MESSAGE,
} from '@/lib/password-reset'

const INPUT_CLASS =
  'h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900'

/**
 * The security page's change-password form: the signed-in user must give the
 * current password, and the new password follows the same strength rules as
 * the reset form (MIN_PASSWORD_LENGTH here, Better Auth's policy on the
 * server, shared messages through passwordPolicyMessage).
 */
export function ChangePasswordForm() {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

  if (done) {
    return (
      <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
        {CHANGE_PASSWORD_SUCCEEDED_MESSAGE}
      </p>
    )
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const currentPassword = String(form.get('currentPassword') ?? '')
    const newPassword = String(form.get('newPassword') ?? '')
    const confirm = String(form.get('confirmPassword') ?? '')
    if (newPassword !== confirm) {
      setError(PASSWORD_MISMATCH_MESSAGE)
      return
    }
    setPending(true)
    setError(null)
    const outcome = await submitPasswordChange(currentPassword, newPassword)
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
        name="currentPassword"
        type="password"
        required
        placeholder="Current password"
        autoComplete="current-password"
        className={INPUT_CLASS}
      />
      <input
        name="newPassword"
        type="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        placeholder="New password"
        autoComplete="new-password"
        className={INPUT_CLASS}
      />
      <input
        name="confirmPassword"
        type="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        placeholder="Confirm new password"
        autoComplete="new-password"
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
        Change password
      </button>
    </form>
  )
}
