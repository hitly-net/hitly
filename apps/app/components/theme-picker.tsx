'use client'

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import {
  applyTheme,
  parseTheme,
  readThemeCookie,
  writeThemeCookie,
  type Theme,
} from '@/lib/theme'

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

const themeStore = {
  listeners: new Set<() => void>(),

  getSnapshot() {
    return readThemeCookie()
  },

  subscribe(callback: () => void) {
    themeStore.listeners.add(callback)
    return () => themeStore.listeners.delete(callback)
  },

  notify() {
    themeStore.listeners.forEach((listener) => listener())
  },

  set(value: Theme) {
    writeThemeCookie(value)
    applyTheme(value)
    themeStore.notify()
  },
}

export function ThemeSync() {
  const theme = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, () => 'system' as Theme)

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])

  return null
}

export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const theme = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, () => 'system' as Theme)

  const select = useCallback((value: string) => {
    themeStore.set(parseTheme(value))
  }, [])

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={compact ? 'grid grid-cols-3 gap-1' : 'flex max-w-md gap-1 rounded-md border border-zinc-200 p-1 dark:border-zinc-700'}
    >
      {OPTIONS.map((option) => {
        const Icon = option.icon
        const selected = theme === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => select(option.value)}
            className={
              selected
                ? 'inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-zinc-900 px-2 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900'
            }
          >
            <Icon className="h-3.5 w-3.5" />
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
