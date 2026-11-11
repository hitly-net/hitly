import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  clampListLimit,
  decodeListCursor,
  encodeListCursor,
  parseCursorParam,
  parseLimitParam,
  takeListPage,
} from './list-cursor'

describe('list cursor', () => {
  it('round-trips createdAt + id and stays opaque', () => {
    const createdAt = new Date('2026-08-13T18:00:00.000Z')
    const encoded = encodeListCursor({ createdAt, id: 'apr_newer' })
    assert.equal(encoded.includes('apr_newer'), false, 'cursor must not leak the id in plaintext')
    assert.equal(encoded.includes('2026-08-13'), false, 'cursor must not leak the timestamp in plaintext')
    assert.deepEqual(decodeListCursor(encoded), { createdAt, id: 'apr_newer' })
  })

  it('rejects invalid cursors', () => {
    assert.equal(decodeListCursor('not-a-cursor'), null)
    assert.equal(decodeListCursor('%%%'), null)
    assert.equal(decodeListCursor(Buffer.from('{}', 'utf8').toString('base64url')), null)
    assert.equal(decodeListCursor(Buffer.from('[]', 'utf8').toString('base64url')), null)
    assert.equal(decodeListCursor(Buffer.from('{"v":1,"t":"nope","i":"apr_1"}', 'utf8').toString('base64url')), null)
    assert.equal(decodeListCursor(Buffer.from('{"v":1,"t":"2026-08-13T18:00:00.000Z","i":""}', 'utf8').toString('base64url')), null)
    assert.equal(decodeListCursor(Buffer.from('{"v":2,"t":"2026-08-13T18:00:00.000Z","i":"apr_1"}', 'utf8').toString('base64url')), null)
  })

  it('parseCursorParam maps garbage to Invalid cursor and omits empty', () => {
    assert.deepEqual(parseCursorParam(null), { ok: true })
    assert.deepEqual(parseCursorParam(''), { ok: true })
    assert.deepEqual(parseCursorParam('   '), { ok: true })
    const bad = parseCursorParam('not-a-cursor')
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.error, 'Invalid cursor')
    const encoded = encodeListCursor({ createdAt: new Date('2026-08-13T18:00:00.000Z'), id: 'apr_1' })
    const parsed = parseCursorParam(encoded)
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.equal(parsed.cursor?.id, 'apr_1')
  })

  it('parseLimitParam and clampListLimit', () => {
    assert.deepEqual(parseLimitParam(null), { ok: true })
    assert.deepEqual(parseLimitParam('10'), { ok: true, limit: 10 })
    const bad = parseLimitParam('ten')
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.error, 'limit must be a whole number')
    assert.equal(clampListLimit(undefined, 50, 200), 50)
    assert.equal(clampListLimit(0, 50, 200), 1)
    assert.equal(clampListLimit(10000, 50, 200), 200)
    assert.equal(clampListLimit(3, 50, 200), 3)
  })

  it('list queries order by created_at DESC, id DESC (drop-id must go red)', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const approvalsSrc = strip(fs.readFileSync(path.join(dir, 'approvals.ts'), 'utf8'))
    const inboxSrc = strip(fs.readFileSync(path.join(dir, 'inbox.ts'), 'utf8'))
    const listFn = approvalsSrc.split('export async function listRequesterPending')[1]?.split('export async function retryResume')[0] ?? ''
    assert.match(
      listFn,
      /orderBy\(desc\(approvals\.createdAt\), desc\(approvals\.id\)\)/,
      'listRequesterPending must keep the id tie-break',
    )
    assert.match(
      inboxSrc,
      /orderBy\(desc\(approvals\.createdAt\), desc\(approvals\.id\)\)/,
      'listInboxItems must keep the id tie-break',
    )
  })

  it('registers a workspace + created_at DESC + id DESC index for those list queries', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const drizzleDir = path.join(dir, '../../../packages/db/drizzle')
    const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>
    }
    const projectStatus = journal.entries.find((e) => e.tag === '0010_project_status')
    const entry = journal.entries.find((e) => e.tag === '0011_approvals_workspace_created_at_id')
    assert.ok(projectStatus, 'drizzle journal must list 0010_project_status (#142) before this index')
    assert.ok(entry, 'drizzle journal must list 0011_approvals_workspace_created_at_id')
    assert.ok(
      journal.entries.indexOf(projectStatus) < journal.entries.indexOf(entry),
      '0011 index migration must apply after 0010_project_status',
    )
    const migration = fs.readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), 'utf8')
    assert.match(
      migration,
      /CREATE INDEX IF NOT EXISTS "approvals_workspace_created_at_id_idx" ON "approvals" USING btree \("workspace_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST\)/,
    )
    assert.doesNotMatch(migration, /NULLS LAST/)
    const schema = fs.readFileSync(path.join(dir, '../../../packages/db/src/schema.ts'), 'utf8')
    assert.match(schema, /table\.createdAt\.desc\(\)\.nullsFirst\(\)/)
    assert.match(schema, /table\.id\.desc\(\)\.nullsFirst\(\)/)
  })

  it('olderThanListCursor is a row comparison (OR-of-lt cannot be an Index Cond)', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const src = fs.readFileSync(path.join(dir, 'list-cursor.ts'), 'utf8')
    assert.match(
      src,
      /sql`\(\$\{createdAtCol\}, \$\{idCol\}\) < \(\$\{cursor\.createdAt\}, \$\{cursor\.id\}\)`/,
    )
    assert.doesNotMatch(src, /or\(lt\(/)
  })

  it('takeListPage encodes nextCursor only when more rows exist', () => {
    const createdAt = new Date('2026-08-13T18:00:00.000Z')
    const rows = [
      { id: 'apr_c', createdAt },
      { id: 'apr_b', createdAt },
      { id: 'apr_a', createdAt },
    ]
    const first = takeListPage(rows.slice(0, 3), 2)
    assert.deepEqual(
      first.page.map((row) => row.id),
      ['apr_c', 'apr_b'],
    )
    assert.equal(typeof first.nextCursor, 'string')
    const decoded = decodeListCursor(first.nextCursor!)
    assert.equal(decoded?.id, 'apr_b')
    const last = takeListPage(rows.slice(2), 2)
    assert.deepEqual(
      last.page.map((row) => row.id),
      ['apr_a'],
    )
    assert.equal(last.nextCursor, null)
  })
})
