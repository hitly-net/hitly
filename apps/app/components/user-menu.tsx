'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { SignOutButton } from '@/components/sign-out-button'
import { ThemePicker } from '@/components/theme-picker'

export function UserMenu({ userName }: { userName: string }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        {userName}
        <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
        >
          <Link
            href="/settings/profile"
            role="menuitem"
            className="block rounded-md px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
            onClick={() => setOpen(false)}
          >
            Profile
          </Link>
          <p className="mt-2 px-2 text-xs font-medium text-zinc-500">Theme</p>
          <div className="mt-1 px-1">
            <ThemePicker compact />
          </div>
          <div className="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
            <SignOutButton className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100" />
          </div>
        </div>
      ) : null}
    </div>
  )
}
