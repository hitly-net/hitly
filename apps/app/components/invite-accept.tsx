'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { AuthForm } from '@/components/auth-form'
import { SignOutButton } from '@/components/sign-out-button'

type Lookup =
  | {
      ok: true
      workspaceName: string
      email: string
      accountExists: boolean
      signedInEmail: string | null
      emailMatches: boolean | null
    }
  | { ok: false; error: string }

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { response, data }
}

export function InviteAccept({ token }: { token: string }) {
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    post('/api/v1/invites/lookup', { token })
      .then(({ data }) => setLookup(data as Lookup))
      .catch(() => setLookup({ ok: false, error: 'Could not reach HITLy. Check your connection and try again.' }))
  }, [token])

  async function accept(extra: Record<string, string> = {}) {
    setPending(true)
    setError(null)
    try {
      const { response, data } = await post('/api/v1/invites/accept', { token, ...extra })
      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Could not accept the invite.')
        setPending(false)
        return
      }
      window.location.href = typeof data.redirectTo === 'string' ? data.redirectTo : '/'
    } catch {
      setError('Could not reach HITLy. Check your connection and try again.')
      setPending(false)
    }
  }

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void accept({ name: String(form.get('name') ?? ''), password: String(form.get('password') ?? '') })
  }

  if (!lookup) return <p className="text-sm text-zinc-500">Checking your invite…</p>
  if (!lookup.ok) return <p className="text-sm text-red-600">{lookup.error}</p>

  const intro = (
    <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
      You&apos;ve been invited to join <strong>{lookup.workspaceName}</strong> as <strong>{lookup.email}</strong>.
    </p>
  )
  const errorLine = error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null
  const button =
    'h-10 w-full rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900'
  const input = 'h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900'

  if (lookup.signedInEmail) {
    if (!lookup.emailMatches) {
      return (
        <div>
          {intro}
          <p className="text-sm text-red-600">
            You&apos;re signed in as {lookup.signedInEmail}. This invite is for {lookup.email}. Sign out, then open the link
            again.
          </p>
          <div className="mt-4">
            <SignOutButton />
          </div>
        </div>
      )
    }
    return (
      <div>
        {intro}
        <button type="button" disabled={pending} className={button} onClick={() => void accept()}>
          Join {lookup.workspaceName}
        </button>
        {errorLine}
      </div>
    )
  }

  if (lookup.accountExists) {
    return (
      <div>
        {intro}
        <p className="mb-4 text-sm text-zinc-500">Sign in to accept.</p>
        <AuthForm action="/api/auth/sign-in/email" submitLabel="Sign in" redirectTo={`/invite/${encodeURIComponent(token)}`} fixedEmail={lookup.email} />
      </div>
    )
  }

  return (
    <div>
      {intro}
      <form onSubmit={onCreate} className="flex flex-col gap-3">
        <input name="name" required placeholder="Name" autoComplete="name" className={input} />
        <input name="email" type="email" value={lookup.email} readOnly autoComplete="username" className={input} />
        <input
          name="password"
          type="password"
          required
          minLength={8}
          placeholder="Password"
          autoComplete="new-password"
          className={input}
        />
        <button type="submit" disabled={pending} className={button}>
          Create account and join
        </button>
      </form>
      {errorLine}
    </div>
  )
}
