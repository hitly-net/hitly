import { useEffect, useState } from 'react'
import { getItem, setItem } from './storage'
import { isInboxScope, type InboxScope } from './components/inbox/InboxScopeTabs'

export type ListFilters = {
  scope: InboxScope
  q: string
}

export function inboxFilterKey(workspaceId: string) {
  return `hitly.inbox-filters.${workspaceId}`
}

export function projectItemsFilterKey(projectId: string) {
  return `hitly.project-items-filters.${projectId}`
}

function parseFilters(raw: string | null): ListFilters | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { scope?: string; q?: string }
    return {
      scope: isInboxScope(parsed.scope) ? parsed.scope : 'open',
      q: typeof parsed.q === 'string' ? parsed.q : '',
    }
  } catch {
    return null
  }
}

export function useListFilters(storageKey: string | null) {
  const [scope, setScope] = useState<InboxScope>('open')
  const [q, setQ] = useState('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!storageKey) {
      setReady(true)
      return
    }
    setReady(false)
    void getItem(storageKey).then((raw) => {
      if (cancelled) return
      const parsed = parseFilters(raw)
      if (parsed) {
        setScope(parsed.scope)
        setQ(parsed.q)
      }
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [storageKey])

  useEffect(() => {
    if (!ready || !storageKey) return
    void setItem(storageKey, JSON.stringify({ scope, q }))
  }, [ready, storageKey, scope, q])

  return { scope, setScope, q, setQ, ready }
}
