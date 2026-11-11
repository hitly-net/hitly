'use client'

import { useState, type FormEvent } from 'react'
import { startRegistration } from '@simplewebauthn/browser'
import {
  PASSKEY_ADDED_MESSAGE,
  PASSKEY_REMOVED_MESSAGE,
  PASSKEY_RENAMED_MESSAGE,
  PASSKEY_UNSUPPORTED_MESSAGE,
  PASSKEY_NAME_MAX_LENGTH,
  submitPasskeyDelete,
  submitPasskeyRegister,
  submitPasskeyRegisterOptions,
  submitPasskeyRename,
  type PasskeyListItem,
} from '@/lib/passkey'

const INPUT_CLASS =
  'h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900'

function formatWhen(value: string | null): string {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Never'
  return date.toLocaleString()
}

export function PasskeySetup({ passkeys: initial }: { passkeys: PasskeyListItem[] }) {
  const [items, setItems] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  async function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const currentPassword = String(data.get('currentPassword') ?? '')
    const name = String(data.get('name') ?? '')
    setPending(true)
    setError(null)
    const options = await submitPasskeyRegisterOptions(currentPassword, name)
    if (!options.ok) {
      form.reset()
      setPending(false)
      setError(options.message)
      return
    }
    try {
      if (typeof window.PublicKeyCredential === 'undefined') {
        setError(PASSKEY_UNSUPPORTED_MESSAGE)
        setPending(false)
        return
      }
      const attestation = await startRegistration({
        optionsJSON: options.options as Parameters<typeof startRegistration>[0]['optionsJSON'],
      })
      const outcome = await submitPasskeyRegister(attestation, name)
      setPending(false)
      if (!outcome.ok) {
        form.reset()
        setError(outcome.message)
        return
      }
      form.reset()
      setMessage(PASSKEY_ADDED_MESSAGE)
      setItems((current) => [outcome.passkey, ...current])
    } catch {
      setPending(false)
      setError(PASSKEY_UNSUPPORTED_MESSAGE)
    }
  }

  async function onRename(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault()
    const form = event.currentTarget
    const name = String(new FormData(form).get('name') ?? '')
    setPending(true)
    setError(null)
    const outcome = await submitPasskeyRename(id, name)
    setPending(false)
    if (!outcome.ok) {
      setError(outcome.message)
      return
    }
    setRenamingId(null)
    setMessage(PASSKEY_RENAMED_MESSAGE)
    setItems((current) => current.map((item) => (item.id === id ? { ...item, name: name.trim() } : item)))
  }

  async function onDelete(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault()
    const form = event.currentTarget
    const currentPassword = String(new FormData(form).get('currentPassword') ?? '')
    setPending(true)
    setError(null)
    const outcome = await submitPasskeyDelete(id, currentPassword)
    setPending(false)
    if (!outcome.ok) {
      form.reset()
      setError(outcome.message)
      return
    }
    setMessage(PASSKEY_REMOVED_MESSAGE)
    setItems((current) => current.filter((item) => item.id !== id))
  }

  return (
    <div className="flex max-w-md flex-col gap-6">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Passkeys let you sign in with this device instead of a password. Adding or removing one
        requires your current password. A passkey sign-in does not ask for an authenticator code.
      </p>
      {message ? (
        <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="text-sm text-zinc-500">No passkeys yet.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((item) => (
            <li key={item.id} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
              {renamingId === item.id ? (
                <form onSubmit={(event) => onRename(event, item.id)} className="flex flex-col gap-2">
                  <input
                    name="name"
                    required
                    maxLength={PASSKEY_NAME_MAX_LENGTH}
                    defaultValue={item.name}
                    aria-label="Passkey name"
                    className={INPUT_CLASS}
                  />
                  <button
                    type="submit"
                    disabled={pending}
                    className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    Save name
                  </button>
                </form>
              ) : (
                <>
                  <p className="font-medium">{item.name}</p>
                  <p className="mt-1 text-xs text-zinc-500">Created {formatWhen(item.createdAt)}</p>
                  <p className="text-xs text-zinc-500">Last used {formatWhen(item.lastUsedAt)}</p>
                  <button
                    type="button"
                    className="mt-2 text-sm text-zinc-600 underline dark:text-zinc-400"
                    onClick={() => setRenamingId(item.id)}
                  >
                    Rename
                  </button>
                </>
              )}
              <form onSubmit={(event) => onDelete(event, item.id)} className="mt-3 flex flex-col gap-2">
                <input
                  name="currentPassword"
                  type="password"
                  required
                  placeholder="Current password"
                  autoComplete="current-password"
                  className={INPUT_CLASS}
                />
                <button
                  type="submit"
                  disabled={pending}
                  className="h-10 rounded-md border border-zinc-300 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
                >
                  Delete passkey
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onRegister} className="flex flex-col gap-3">
        <input
          name="name"
          required
          maxLength={PASSKEY_NAME_MAX_LENGTH}
          placeholder="Passkey name"
          autoComplete="off"
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
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Add passkey
        </button>
      </form>
    </div>
  )
}
