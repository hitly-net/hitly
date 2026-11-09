import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { projects } from '@hitly/db/schema'
import { requireDb, requireTenantWorkspaceId } from './tenant'
import { decodeTenantJson, encodeTenantJson } from './tenant-crypto'

/**
 * Per-project WEBHOOK signing keys (M0h, hitly#106 item 9).
 *
 * Callback HMACs are signed with a DEDICATED webhook secret, never with the
 * resume secret: `resumeSecret` (= HITLY_RESUME_SECRET on the origin side)
 * authenticates origin->Hitly polls; `webhookSigningSecrets` authenticates
 * Hitly->origin callbacks. Two credentials, two purposes - rotating one must
 * never invalidate the other, and a leaked webhook key cannot forge polls.
 *
 * Stored (tenant-encrypted) on projects.credentials:
 *   webhookSigningSecrets: Array<{ keyId, secret, createdAt, validUntil }>
 * The newest usable key signs. Rotation stamps the outgoing keys with
 * `validUntil = now + overlapSeconds`: inside that window receivers can
 * verify BOTH keys (see @hitly/plugin-http verifyHttpSignature `keys`);
 * after it only the new key verifies.
 */

export interface StoredSigningKey {
  keyId: string
  secret: string
  /** Unix seconds. */
  createdAt: number
  /** Unix seconds; null = active. */
  validUntil: number | null
}

/** Default rotation overlap: old keys still verify for 24 hours. */
export const WEBHOOK_ROTATION_OVERLAP_SECONDS = 24 * 60 * 60

function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`
}

function newSigningKeyId(): string {
  return `whk_${randomBytes(8).toString('hex')}`
}

function parseStoredEntries(credentials: Record<string, unknown>): StoredSigningKey[] {
  const bag = credentials.webhookSigningSecrets
  if (!Array.isArray(bag)) return []
  const out: StoredSigningKey[] = []
  for (const item of bag) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.keyId !== 'string' || !record.keyId.trim()) continue
    if (typeof record.secret !== 'string' || !record.secret.trim()) continue
    out.push({
      keyId: record.keyId.trim(),
      secret: record.secret.trim(),
      createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0,
      validUntil:
        typeof record.validUntil === 'number' && Number.isFinite(record.validUntil) ? record.validUntil : null,
    })
  }
  return out
}

function usableEntries(entries: StoredSigningKey[], nowSeconds: number): StoredSigningKey[] {
  return entries.filter((entry) => entry.validUntil === null || entry.validUntil > nowSeconds)
}

/**
 * Ensure the project has an active webhook signing key, provisioning one when
 * the registry is empty or fully rotated out. Returns the project with the
 * (possibly updated) DECODED credentials to pass straight to the plugin.
 */
export async function ensureProjectWebhookSecret(project: { id: string; workspaceId: string; credentials: Record<string, unknown> }) {
  const workspaceId = project.workspaceId
  const credentials = await decodeTenantJson(workspaceId, project.credentials)
  const now = Math.floor(Date.now() / 1000)
  const entries = parseStoredEntries(credentials)
  const active = usableEntries(entries, now)
  if (active.length > 0) {
    return { project: { ...project, credentials }, activeKey: active.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)) }
  }
  const entry: StoredSigningKey = {
    keyId: newSigningKeyId(),
    secret: generateWebhookSecret(),
    createdAt: now,
    validUntil: null,
  }
  const next = { ...credentials, webhookSigningSecrets: [...entries, entry] }
  await requireDb()
    .update(projects)
    .set({ credentials: await encodeTenantJson(workspaceId, next), updatedAt: new Date() })
    .where(and(eq(projects.id, project.id), eq(projects.workspaceId, workspaceId)))
  return { project: { ...project, credentials: next }, activeKey: entry }
}

/**
 * Rotate the project webhook secret with an OVERLAP WINDOW: the new key signs
 * from now on; every currently-usable key gets `validUntil = now + overlap`
 * so in-flight callbacks remain verifiable with the old secret for a while.
 * Entries already past their window are dropped.
 */
export async function rotateProjectWebhookSecret(
  projectId: string,
  opts?: { overlapSeconds?: number },
): Promise<
  | { ok: true; keyId: string; webhookSecret: string; overlapUntil: number; retainedKeys: number }
  | { error: 'Project not found' }
> {
  const workspaceId = requireTenantWorkspaceId()
  const database = requireDb()
  const rows = await database
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1)
  const project = rows[0]
  if (!project) return { error: 'Project not found' as const }
  const credentials = await decodeTenantJson(workspaceId, project.credentials)
  const now = Math.floor(Date.now() / 1000)
  const overlapSeconds = Math.max(0, Math.floor(opts?.overlapSeconds ?? WEBHOOK_ROTATION_OVERLAP_SECONDS))
  const entries = parseStoredEntries(credentials)
  const retained = usableEntries(entries, now).map((entry) => ({ ...entry, validUntil: now + overlapSeconds }))
  const newestRetained = retained.reduce((max, entry) => Math.max(max, entry.createdAt), 0)
  const entry: StoredSigningKey = {
    keyId: newSigningKeyId(),
    secret: generateWebhookSecret(),
    // Strictly newer than every retained key so the active-key pick is unambiguous.
    createdAt: Math.max(now, newestRetained + 1),
    validUntil: null,
  }
  const next = { ...credentials, webhookSigningSecrets: [...retained, entry] }
  await database
    .update(projects)
    .set({ credentials: await encodeTenantJson(workspaceId, next), updatedAt: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
  return { ok: true as const, keyId: entry.keyId, webhookSecret: entry.secret, overlapUntil: now + overlapSeconds, retainedKeys: retained.length }
}

/** Read the currently-active webhook key without provisioning one. */
export async function readActiveWebhookKey(project: {
  workspaceId: string
  credentials: Record<string, unknown>
}): Promise<StoredSigningKey | null> {
  const credentials = await decodeTenantJson(project.workspaceId, project.credentials)
  const now = Math.floor(Date.now() / 1000)
  const active = usableEntries(parseStoredEntries(credentials), now)
  if (active.length === 0) return null
  return active.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
}
