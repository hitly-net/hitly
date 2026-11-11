import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchInboxPage, type InboxFetcher, type InboxPage } from './inbox-pages'
import { createInboxRefreshGate } from './inbox-refresh'
import type { WorkItemRow } from './types'

function row(id: string, actionName: string): WorkItemRow {
  return {
    id,
    status: 'pending',
    actionName,
    plugin: 'mastra',
    projectId: 'prj_1',
    projectName: 'Test',
    createdAt: '2026-08-19T12:00:00Z',
    expiresAt: null,
  }
}

test('refresh resets to page 1 (no cursor) and replaces items', async () => {
  const calls: Array<{ cursor?: string } | undefined> = []
  const inbox: InboxFetcher = async (query) => {
    calls.push(query)
    return { items: [row('apr_new', 'fresh')], nextCursor: 'c2' }
  }
  const gate = createInboxRefreshGate()
  let page: InboxPage | undefined
  let refreshing = false
  await gate.refresh(() => fetchInboxPage(inbox, { scope: 'open' }), {
    setRefreshing: (value) => {
      refreshing = value
    },
    applyPage: (next) => {
      page = next
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.cursor, undefined, 'refresh must not send a pagination cursor')
  assert.deepEqual(
    page?.items.map((item) => item.id),
    ['apr_new'],
  )
  assert.equal(page?.nextCursor, 'c2')
  assert.equal(refreshing, false)
})

test('refresh shows the loading state before the fetch resolves', async () => {
  const gate = createInboxRefreshGate()
  let refreshing = false
  const seen: boolean[] = []
  let resolve!: (page: InboxPage) => void
  const pending = new Promise<InboxPage>((next) => {
    resolve = next
  })
  const done = gate.refresh(
    async () => {
      seen.push(refreshing)
      return pending
    },
    {
      setRefreshing: (value) => {
        refreshing = value
      },
      applyPage: () => undefined,
    },
  )
  assert.equal(refreshing, true, 'loading state must be on before the fetch runs')
  resolve({ items: [row('apr_1', 'a')], nextCursor: null })
  await done
  assert.deepEqual(seen, [true])
  assert.equal(refreshing, false)
})

test('double refresh triggers only one fetch', async () => {
  const gate = createInboxRefreshGate()
  let fetches = 0
  let resolve!: (page: InboxPage) => void
  const pending = new Promise<InboxPage>((next) => {
    resolve = next
  })
  const fetchPage1 = async () => {
    fetches += 1
    return pending
  }
  const apply = {
    setRefreshing: () => undefined,
    applyPage: () => undefined,
  }
  const first = gate.refresh(fetchPage1, apply)
  const second = gate.refresh(fetchPage1, apply)
  assert.equal(fetches, 1, 'a second refresh while busy must not start another fetch')
  assert.equal(first, second, 'the second call joins the in-flight promise')
  resolve({ items: [], nextCursor: null })
  await Promise.all([first, second])
  assert.equal(fetches, 1)
  assert.equal(gate.busy, false)
})
