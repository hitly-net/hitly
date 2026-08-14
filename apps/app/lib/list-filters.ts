export const INBOX_SCOPES = ['all', 'open', 'closed'] as const
export type InboxScope = (typeof INBOX_SCOPES)[number]

export type ListFilters = {
  scope: InboxScope
  q: string
  projectId?: string
}

export function inboxFilterStorageKey(workspaceId: string) {
  return `hitly-inbox-filters:${workspaceId}`
}

export function projectItemsFilterStorageKey(projectId: string) {
  return `hitly-project-items-filters:${projectId}`
}

export function isInboxScope(value: string | undefined): value is InboxScope {
  return Boolean(value && (INBOX_SCOPES as readonly string[]).includes(value))
}

export function parseListFilters(values: { scope?: string; q?: string; projectId?: string }): ListFilters {
  return {
    scope: isInboxScope(values.scope) ? values.scope : 'all',
    q: values.q?.trim() ?? '',
    projectId: values.projectId?.trim() || undefined,
  }
}

export function listFiltersHref(path: string, filters: ListFilters) {
  const params = new URLSearchParams()
  params.set('scope', filters.scope)
  if (filters.q) params.set('q', filters.q)
  if (filters.projectId) params.set('projectId', filters.projectId)
  return `${path}?${params.toString()}`
}

export function isDefaultListFilters(filters: ListFilters) {
  return filters.scope === 'all' && !filters.q && !filters.projectId
}

export function readListFilters(storageKey: string): ListFilters | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { scope?: string; q?: string; projectId?: string }
    return parseListFilters(parsed)
  } catch {
    return null
  }
}

export function writeListFilters(storageKey: string, filters: ListFilters) {
  if (typeof window === 'undefined') return
  try {
    if (isDefaultListFilters(filters)) window.localStorage.removeItem(storageKey)
    else window.localStorage.setItem(storageKey, JSON.stringify(filters))
  } catch {
    // Ignore quota / private-mode failures.
  }
}
