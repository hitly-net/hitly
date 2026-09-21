'use client'

export function SignOutButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className ?? 'text-sm text-zinc-500 hover:text-zinc-900'}
      onClick={async () => {
        try {
          const response = await fetch('/api/auth/sign-out', {
            method: 'POST',
            credentials: 'include',
          })
          if (!response.ok) {
            console.error('[hitly sign-out] Server returned error:', response.status)
            return
          }
          document.cookie = 'hitly-workspace-id=; Path=/; Max-Age=0; SameSite=Lax'
          document.cookie = 'better-auth.session_token=; Path=/; Max-Age=0; SameSite=Lax'
          document.cookie = '__Secure-better-auth.session_token=; Path=/; Max-Age=0; Secure; SameSite=Lax'
          window.location.href = '/login'
        } catch (error) {
          console.error('[hitly sign-out] Failed to sign out:', error)
        }
      }}
    >
      Sign out
    </button>
  )
}
