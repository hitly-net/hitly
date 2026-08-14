'use client'

import { useRouter } from 'next/navigation'

export function SignOutButton() {
  const router = useRouter()
  return (
    <button
      type="button"
      className="text-sm text-zinc-500 hover:text-zinc-900"
      onClick={async () => {
        await fetch('/api/auth/sign-out', { method: 'POST' })
        router.push('/login')
        router.refresh()
      }}
    >
      Sign out
    </button>
  )
}
