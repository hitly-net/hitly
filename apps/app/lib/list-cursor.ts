/**
 * Opaque cursor pagination for list endpoints (hitly#104).
 *
 * Order matches #107: `created_at DESC, id DESC`. The id tie-break is required
 * so equal timestamps never skip or repeat across pages.
 */
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'

export type ListCursor = { createdAt: Date; id: string }

const CURSOR_VERSION = 1

export function encodeListCursor(cursor: ListCursor): string {
  const payload = JSON.stringify({
    v: CURSOR_VERSION,
    t: cursor.createdAt.toISOString(),
    i: cursor.id,
  })
  return Buffer.from(payload, 'utf8').toString('base64url')
}

export function decodeListCursor(raw: string): ListCursor | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as { v?: unknown; t?: unknown; i?: unknown }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (parsed.v !== CURSOR_VERSION) return null
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string' || parsed.i.length === 0) return null
    const createdAt = new Date(parsed.t)
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== parsed.t) return null
    return { createdAt, id: parsed.i }
  } catch {
    return null
  }
}

export function parseLimitParam(
  raw: string | null,
): { ok: true; limit?: number } | { ok: false; error: string } {
  if (raw === null) return { ok: true }
  if (!/^\d+$/.test(raw)) return { ok: false, error: 'limit must be a whole number' }
  return { ok: true, limit: Number(raw) }
}

export function parseCursorParam(
  raw: string | null,
): { ok: true; cursor?: ListCursor } | { ok: false; error: string } {
  if (raw === null) return { ok: true }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true }
  const cursor = decodeListCursor(trimmed)
  if (!cursor) return { ok: false, error: 'Invalid cursor' }
  return { ok: true, cursor }
}

export function clampListLimit(limit: number | undefined, defaultLimit: number, maxLimit: number): number {
  return Math.min(Math.max(Math.trunc(limit ?? defaultLimit), 1), maxLimit)
}

/**
 * Rows strictly older than `cursor` in `created_at DESC, id DESC` order.
 * Tuple `<` is the same as `created_at < t OR (created_at = t AND id < i)` for
 * these NOT NULL columns, and Postgres can use it as an Index Cond.
 */
export function olderThanListCursor(
  createdAtCol: SQLWrapper,
  idCol: SQLWrapper,
  cursor: ListCursor,
): SQL | undefined {
  return sql`(${createdAtCol}, ${idCol}) < (${cursor.createdAt}, ${cursor.id})`
}

export function takeListPage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): { page: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  return {
    page,
    nextCursor: hasMore && last ? encodeListCursor({ createdAt: last.createdAt, id: last.id }) : null,
  }
}
