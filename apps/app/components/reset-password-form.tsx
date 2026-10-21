'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import {
  FORGOT_PASSWORD_PAGE,
  MIN_PASSWORD_LENGTH,
  PASSWORD_MISMATCH_MESSAGE,
  RESET_LINK_INVALID_MESSAGE,
  submitNewPassword,
} from '@/lib/password-reset'

function RequestNewLink() {
  return (
    <Link href={FORGOT_PASSWORD_PAGE} className="text-sm text-zinc-500 underline">
      Request a new link
    </Link>
  )
}

export function ResetPasswordForm({ token }: { token: string | null }) {
  const [error, setError] = useState<string | null>(null)
  const [offerNewLink, setOfferNewLink] = useState(false)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

  if (!token) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-sm text-red-600">
          {RESET_LINK_INVALID_MESSAGE}
        </p>
        <RequestNewLink />
      </div>
    )
  }

  if (done) {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
          Your password has been updated.
        </p>
        <Link href="/login" className="text-sm text-zinc-500 underline">
          Log in
        </Link>
      </div>
    )
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const newPassword = String(form.get('newPassword') ?? '')
    const confirm = String(form.get('confirmPassword') ?? '')
    if (newPassword !== confirm) {
      setError(PASSWORD_MISMATCH_MESSAGE)
      setOfferNewLink(false)
      return
    }
    setPending(true)
    setError(null)
    setOfferNewLink(false)
    const outcome = await submitNewPassword(token as string, newPassword)
    if (outcome.ok) {
      setDone(true)
    } else {
      formElement.reset()
      setError(outcome.message)
      setOfferNewLink(outcome.requestNewLink)
    }
    setPending(false)
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <input
        name="newPassword"
        type="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        placeholder="New password"
        autoComplete="new-password"
        className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
      <input
        name="confirmPassword"
        type="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        placeholder="Confirm new password"
        autoComplete="new-password"
        className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {offerNewLink ? <RequestNewLink /> : null}
      <button
        type="submit"
        disabled={pending}
        className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        Update password
      </button>
    </form>
  )
}
