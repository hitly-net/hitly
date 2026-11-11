'use client'

import { useEffect, useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { PASSKEY_SIGN_IN_FAILED_MESSAGE, PASSKEY_UNSUPPORTED_MESSAGE } from '@/lib/passkey'

/**
 * Sign in with a registered passkey. Conditional UI / autofill starts when
 * the browser supports it (the login email field includes `webauthn` in
 * autocomplete). A successful passkey sign-in is a full session and does
 * not continue to the authenticator-app MFA step.
 */
export function PasskeySignIn({ redirectTo }: { redirectTo?: string }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function conditional() {
      if (typeof window.PublicKeyCredential === 'undefined') return
      const mediation = (
        window.PublicKeyCredential as unknown as {
          isConditionalMediationAvailable?: () => Promise<boolean>
        }
      ).isConditionalMediationAvailable
      if (typeof mediation !== 'function') return
      const available = await mediation.call(window.PublicKeyCredential)
      if (!available || cancelled) return
      const result = await authClient.signIn.passkey({ autoFill: true })
      if (cancelled) return
      if (result.data) {
        window.location.href = redirectPath(redirectTo)
      }
    }
    void conditional()
    return () => {
      cancelled = true
    }
  }, [redirectTo])

  async function onClick() {
    setPending(true)
    setError(null)
    try {
      if (typeof window.PublicKeyCredential === 'undefined') {
        setError(PASSKEY_UNSUPPORTED_MESSAGE)
        setPending(false)
        return
      }
      const result = await authClient.signIn.passkey()
      if (result.error) {
        setError(PASSKEY_SIGN_IN_FAILED_MESSAGE)
        setPending(false)
        return
      }
      window.location.href = redirectPath(redirectTo)
    } catch {
      setError(PASSKEY_SIGN_IN_FAILED_MESSAGE)
      setPending(false)
    }
  }

  return (
    <div className="mb-4 flex flex-col gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => void onClick()}
        className="h-10 rounded-md border border-zinc-300 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
      >
        Sign in with a passkey
      </button>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function redirectPath(redirectTo?: string) {
  if (redirectTo && redirectTo.startsWith('/') && !redirectTo.startsWith('//')) return redirectTo
  return '/'
}
