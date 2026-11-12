/**
 * M0h item 9 (PR hitly#106): callbacks sign with a DEDICATED per-project
 * webhook secret (key-id carrying registry on credentials.webhookSigningSecrets),
 * NEVER with HITLY_RESUME_SECRET (credentials.resumeSecret, which stays the
 * origin->HITLy poll credential) - and rotation keeps the outgoing key
 * verifiable for an OVERLAP WINDOW. Real Postgres + capturing receiver.
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test, before, after } from 'node:test'
import { eq } from 'drizzle-orm'
import { projects } from '@hitly/db/schema'
import { verifyHttpSignature, type SigningKeyEntry } from '@hitly/plugin-http'
import { decideApproval } from './approvals'
import { rotateProjectWebhookSecret } from './webhook-secret'
import { withTenant } from './tenant'
import { decodeTenantJson } from './tenant-crypto'
import {
  closeM0hFixture,
  createM0hFixture,
  ingestHttpAsk,
  startCapturingReceiver,
  type CapturingReceiver,
  type M0hFixture,
} from './m0h-fixture'

if (!process.env.HITLY_ENCRYPTION_KEK) throw new Error('HITLY_ENCRYPTION_KEK required for tests')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for tests')

let fixture: M0hFixture
let receiver: CapturingReceiver

before(async () => {
  fixture = await createM0hFixture()
  receiver = await startCapturingReceiver()
})

after(async () => {
  await receiver?.close()
  if (fixture) await closeM0hFixture(fixture)
})

async function storedCredentials(): Promise<Record<string, unknown>> {
  const rows = await fixture.db
    .select({ credentials: projects.credentials })
    .from(projects)
    .where(eq(projects.id, fixture.projectId))
    .limit(1)
  assert.ok(rows[0], 'project row exists')
  return (await decodeTenantJson(fixture.workspaceId, rows[0]!.credentials)) as Record<string, unknown>
}

function registry(creds: Record<string, unknown>): Array<Record<string, unknown>> {
  const bag = creds.webhookSigningSecrets
  assert.ok(Array.isArray(bag), 'credentials.webhookSigningSecrets must be an array')
  return bag as Array<Record<string, unknown>>
}

async function decideOne(): Promise<string> {
  const approval = await ingestHttpAsk(fixture, receiver.url)
  const decided = await decideApproval({
    approvalId: approval.id,
    actorUserId: fixture.reviewerId,
    payload: { decision: 'accept' },
    workspaceId: fixture.workspaceId,
  })
  if ('error' in decided) throw new Error(`decide failed: ${decided.error}`)
  assert.equal(decided.status, 'decided')
  return approval.id
}

function hmac(secret: string, ts: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest('hex')
}

test('decide auto-provisions a dedicated webhook key and signs with it, never the resume secret', async () => {
  await decideOne()
  const creds = await storedCredentials()
  const entries = registry(creds)
  assert.equal(entries.length, 1, 'one active key provisioned')
  const entry = entries[0]!
  assert.match(String(entry.keyId), /^whk_/, 'key carries a stable key id')
  assert.match(String(entry.secret), /^whsec_/, 'dedicated webhook secret namespace')
  assert.equal(entry.validUntil, null, 'active key has no expiry')

  const resumeSecret = String(creds.resumeSecret ?? '')
  assert.match(resumeSecret, /^hitly_resume_/, 'resume secret is still provisioned (for origin polls)')
  assert.notEqual(entry.secret, resumeSecret, 'the two credentials are distinct')

  // Wire check: signature = HMAC over "<ts>.<exact bytes>" with the WEBHOOK key.
  const hit = receiver.hits[receiver.hits.length - 1]!
  const ts = hit.headers['x-hitly-timestamp']!
  assert.equal(hit.headers['x-hitly-key-id'], String(entry.keyId), 'stored key id advertised')
  assert.equal(hit.headers['x-hitly-signature'], hmac(String(entry.secret), ts, hit.rawBody))
  assert.notEqual(
    hit.headers['x-hitly-signature'],
    hmac(resumeSecret, ts, hit.rawBody),
    'callbacks must NOT be signed with HITLY_RESUME_SECRET (item 9)',
  )

  // Receiver-side verification against the registry works.
  const verified = verifyHttpSignature({
    keys: entries as unknown as SigningKeyEntry[],
    rawBody: hit.rawBody,
    timestampHeader: ts,
    signatureHeader: hit.headers['x-hitly-signature'],
    keyIdHeader: hit.headers['x-hitly-key-id'],
  })
  assert.equal(verified.ok, true, 'receiver verifies with the webhook registry')
})

test('rotation switches signing to the new key and keeps the old one verifiable inside the overlap window', async () => {
  const rotation = await withTenant(fixture.workspaceId, () =>
    rotateProjectWebhookSecret(fixture.projectId, { overlapSeconds: 3600 }),
  )
  if ('error' in rotation) throw new Error(`rotation should succeed: ${rotation.error}`)
  const rot = rotation

  const creds = await storedCredentials()
  const entries = registry(creds)
  assert.equal(entries.length, 2, 'old key retained for the overlap window')
  const oldEntry = entries.find((e) => e.validUntil !== null)!
  const newEntry = entries.find((e) => e.validUntil === null)!
  assert.equal(newEntry.keyId, rot.keyId)
  assert.equal(newEntry.secret, rot.webhookSecret)
  const now = Math.floor(Date.now() / 1000)
  assert.ok(
    Number(oldEntry.validUntil) > now && Number(oldEntry.validUntil) <= now + 3600 + 5,
    'rotated-out key keeps a bounded overlap window',
  )

  // New deliveries sign with the NEW key.
  await decideOne()
  const hit = receiver.hits[receiver.hits.length - 1]!
  const ts = hit.headers['x-hitly-timestamp']!
  assert.equal(hit.headers['x-hitly-key-id'], rot.keyId, 'new deliveries use the new key id')
  assert.equal(hit.headers['x-hitly-signature'], hmac(rot.webhookSecret, ts, hit.rawBody))
  const staleHmac = hmac(String(oldEntry.secret), ts, hit.rawBody)
  assert.notEqual(hit.headers['x-hitly-signature'], staleHmac, 'old secret must no longer sign')

  // Overlap: a callback bearing the OLD key still verifies right now...
  const probeBody = '{"decision":"accept","probe":"overlap"}'
  const probeTs = Math.floor(Date.now() / 1000)
  const insideWindow = verifyHttpSignature({
    keys: entries as unknown as SigningKeyEntry[],
    rawBody: probeBody,
    timestampHeader: String(probeTs),
    signatureHeader: hmac(String(oldEntry.secret), String(probeTs), probeBody),
    keyIdHeader: String(oldEntry.keyId),
  })
  assert.equal(insideWindow.ok, true, 'rotated-out key verifies inside the overlap window')

  // ...and is refused once the window has closed.
  const afterWindow = verifyHttpSignature({
    keys: entries as unknown as SigningKeyEntry[],
    rawBody: probeBody,
    timestampHeader: String(Number(oldEntry.validUntil) + 60),
    signatureHeader: hmac(String(oldEntry.secret), String(Number(oldEntry.validUntil) + 60), probeBody),
    keyIdHeader: String(oldEntry.keyId),
    nowSeconds: Number(oldEntry.validUntil) + 60,
    maxSkewSeconds: 86_400,
  })
  assert.equal(afterWindow.ok, false)
  assert.ok(!afterWindow.ok && afterWindow.reason === 'expired_key', 'old key refused after the overlap window')
})
