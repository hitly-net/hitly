/**
 * Mobile inbox must send nextCursor on later fetches so item 101 is reachable.
 *
 * Mutant M-mobile: if fetchInboxPage / collectInboxPages / the screens omit
 * cursor on later fetches, the mock always returns page 1 and this file goes red.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { appendInboxItems, collectInboxPages, fetchInboxPage, type InboxPage } from './inbox-pages'
import type { WorkItemRow } from './types'

const dir = path.dirname(fileURLToPath(import.meta.url))

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

test('source: inbox screens and client send nextCursor on later fetches', () => {
  const inboxSrc = fs.readFileSync(path.join(dir, '../app/(tabs)/inbox.tsx'), 'utf8')
  const projectSrc = fs.readFileSync(path.join(dir, '../app/projects/[id]/index.tsx'), 'utf8')
  const clientSrc = fs.readFileSync(path.join(dir, 'api/hitly-client.ts'), 'utf8')
  const listSrc = fs.readFileSync(path.join(dir, 'components/inbox/WorkItemList.tsx'), 'utf8')
  assert.match(clientSrc, /if \(query\?\.cursor\) params\.set\('cursor', query\.cursor\)/, 'inbox() must send cursor')
  assert.match(inboxSrc, /fetchInboxPage/, 'inbox screen must use fetchInboxPage')
  assert.match(inboxSrc, /nextCursor/, 'inbox screen must keep nextCursor for later fetches')
  assert.match(inboxSrc, /onLoadMore/, 'inbox screen must load more')
  assert.match(projectSrc, /fetchInboxPage/, 'project items screen must use fetchInboxPage')
  assert.match(projectSrc, /nextCursor/, 'project items screen must keep nextCursor for later fetches')
  assert.match(projectSrc, /onLoadMore/, 'project items screen must load more')
  assert.match(listSrc, /More items — load more/, 'list must show an honest remaining-items control')
})

test('pull-to-refresh calls AttentionProvider refresh()', () => {
  const inboxSrc = fs.readFileSync(path.join(dir, '../app/(tabs)/inbox.tsx'), 'utf8')
  assert.match(
    inboxSrc,
    /const \{ screenEpoch, refresh \} = useAttention\(\)/,
    'inbox must take refresh from AttentionProvider',
  )
  const start = inboxSrc.indexOf('const refreshFromStart')
  const end = inboxSrc.indexOf('const loadMore')
  assert.ok(start >= 0 && end > start, 'refreshFromStart must be the pull-to-refresh handler')
  const refreshFromStart = inboxSrc.slice(start, end)
  assert.match(refreshFromStart, /void refresh\(\)/, 'pull-to-refresh must call AttentionProvider refresh()')
  assert.match(
    inboxSrc,
    /onRefresh=\{\(\) => void refreshFromStart\(\)\}/,
    'RefreshControl must use the handler that calls AttentionProvider refresh()',
  )
})

test('source: inbox list has pull-to-refresh and a header refresh button', () => {
  const inboxSrc = fs.readFileSync(path.join(dir, '../app/(tabs)/inbox.tsx'), 'utf8')
  const listSrc = fs.readFileSync(path.join(dir, 'components/inbox/WorkItemList.tsx'), 'utf8')
  assert.match(listSrc, /RefreshControl/, 'list must use RefreshControl for pull-to-refresh')
  assert.match(inboxSrc, /createInboxRefreshGate/, 'inbox screen must single-flight page-1 refreshes')
  assert.match(inboxSrc, /accessibilityLabel="Refresh inbox"/, 'inbox screen must show a visible refresh button')
  assert.match(inboxSrc, /onRefresh=\{\(\) => void refreshFromStart\(\)\}/, 'pull-to-refresh must re-fetch from page 1')
  assert.match(
    inboxSrc,
    /fetchInboxPage\(client\.inbox, \{ scope, q: q\.trim\(\) \|\| undefined \}\)/,
    'refresh must call fetchInboxPage without a cursor (page 1)',
  )
})

test('collectInboxPages follows nextCursor so item 101 is reachable', async () => {
  const catalog = Array.from({ length: 101 }, (_, i) => row(`apr_${String(i + 1).padStart(4, '0')}`, `reach-${i + 1}`))
  const pageSize = 50
  const calls: Array<string | undefined> = []
  const inbox = async (query?: { cursor?: string }): Promise<InboxPage> => {
    calls.push(query?.cursor)
    const start = query?.cursor ? catalog.findIndex((item) => item.id === query.cursor) + 1 : 0
    const page = catalog.slice(Math.max(start, 0), Math.max(start, 0) + pageSize)
    const last = page[page.length - 1]
    const more = Math.max(start, 0) + page.length < catalog.length
    return { items: page, nextCursor: more && last ? last.id : null }
  }

  const first = await fetchInboxPage(inbox, { scope: 'open' })
  assert.equal(first.items.length, 50)
  assert.equal(first.items.some((item) => item.id === 'apr_0101'), false)

  const all = await collectInboxPages(inbox, { scope: 'open' })
  assert.equal(all.items.length, 101)
  assert.equal(all.items[100]?.id, 'apr_0101', 'item 101 must be reachable by following nextCursor')
  assert.equal(all.hasMore, false)
  assert.ok(calls.includes('apr_0050'), 'later fetches must send the previous nextCursor')
  assert.ok(calls.includes('apr_0100'))

  const merged = appendInboxItems(first.items, [{ ...row('apr_0001', 'dup'), actionName: 'dup' }, row('apr_0101', 'reach-101')])
  assert.equal(merged.some((item) => item.id === 'apr_0001' && item.actionName === 'dup'), false, 'append must not duplicate ids')
  assert.equal(merged[merged.length - 1]?.id, 'apr_0101')
})
