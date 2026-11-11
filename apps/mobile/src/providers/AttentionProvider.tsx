import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { usePathname } from 'expo-router'
import { setAppBadge } from '../badge'
import { useSession } from './SessionProvider'
import type { InboxSummary } from '../types'

const empty: InboxSummary = { pending: 0, failedResume: 0, decidedToday: 0, projectCount: 0 }

type AttentionContextValue = {
  summary: InboxSummary
  alertCount: number
  screenEpoch: number
  refresh: () => Promise<void>
  refreshScreen: () => Promise<void>
}

const AttentionContext = createContext<AttentionContextValue | null>(null)

export function AttentionProvider({ children }: { children: ReactNode }) {
  const { client, token } = useSession()
  const pathname = usePathname()
  const [summary, setSummary] = useState<InboxSummary>(empty)
  const [screenEpoch, setScreenEpoch] = useState(0)

  const refresh = useCallback(async () => {
    if (!client || !token) {
      setSummary(empty)
      void setAppBadge(0)
      return
    }
    try {
      const next = await client.summary()
      setSummary(next)
      void setAppBadge(next.pending)
    } catch {
      // Keep the last known counts if the probe fails.
    }
  }, [client, token])

  useEffect(() => {
    void refresh()
  }, [refresh, pathname])

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh()
    })
    return () => sub.remove()
  }, [refresh])

  useEffect(() => {
    if (!token) return
    const timer = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(timer)
  }, [refresh, token])

  const refreshScreen = useCallback(async () => {
    await refresh()
    setScreenEpoch((n) => n + 1)
  }, [refresh])

  const value = useMemo(
    () => ({
      summary,
      // Pending badge: only items awaiting a human (failed_resume rows
      // already carry a human decision and must not count here).
      alertCount: summary.pending,
      screenEpoch,
      refresh,
      refreshScreen,
    }),
    [refresh, refreshScreen, screenEpoch, summary],
  )

  return <AttentionContext.Provider value={value}>{children}</AttentionContext.Provider>
}

export function useAttention() {
  const value = useContext(AttentionContext)
  if (!value) throw new Error('useAttention must be used within AttentionProvider')
  return value
}
