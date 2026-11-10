import type { WorkItemRow } from './types'

export type InboxListQuery = { scope?: string; q?: string; projectId?: string }

export type InboxPage = { items: WorkItemRow[]; nextCursor: string | null }

export type InboxFetcher = (query?: InboxListQuery & { cursor?: string }) => Promise<InboxPage>

/** First page, or a later page when `cursor` is the previous `nextCursor`. */
export async function fetchInboxPage(
  inbox: InboxFetcher,
  query: InboxListQuery = {},
  cursor?: string | null,
): Promise<InboxPage> {
  return inbox({
    ...query,
    ...(cursor ? { cursor } : {}),
  })
}

export function appendInboxItems(existing: WorkItemRow[], incoming: WorkItemRow[]): WorkItemRow[] {
  const seen = new Set(existing.map((item) => item.id))
  return [...existing, ...incoming.filter((item) => !seen.has(item.id))]
}

/**
 * Walk `nextCursor` until exhausted or `maxPages`.
 *
 * Mutant M-mobile: if later fetches omit `cursor` (always page 1), item 101
 * never appears and collectInboxPages tests go red.
 */
export async function collectInboxPages(
  inbox: InboxFetcher,
  query: InboxListQuery = {},
  maxPages = 20,
): Promise<{ items: WorkItemRow[]; nextCursor: string | null; hasMore: boolean }> {
  let items: WorkItemRow[] = []
  let cursor: string | undefined
  let nextCursor: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchInboxPage(inbox, query, cursor)
    items = appendInboxItems(items, result.items)
    nextCursor = result.nextCursor
    if (!nextCursor) break
    cursor = nextCursor
  }
  return { items, nextCursor, hasMore: Boolean(nextCursor) }
}
