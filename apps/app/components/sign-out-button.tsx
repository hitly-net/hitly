'use client'

import { performSignOut } from '@/lib/sign-out'

export function SignOutButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className ?? 'text-sm text-zinc-500 hover:text-zinc-900'}
      onClick={() => {
        void performSignOut()
      }}
    >
      Sign out
    </button>
  )
}
