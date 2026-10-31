/**
 * Unit tests for the `presented` evidence event (hitl-spec 5.2) and the new
 * `oversight.decidedBy` / `oversight.client` fields (hitl-spec 4.1, 5.3).
 * Builder-level only: the DB spine for markApprovalPresented/decide lives in
 * lib/approvals.spine.test.ts.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDecidedEvent, buildPresentedEvent } from './evidence'
import { hashEvidenceContent, type ApprovalEnvelope, type DecisionPayload, type OriginRef } from '@hitly/core'

const envelope: ApprovalEnvelope = {
  action: { name: 'test-action', args: { amount: 100 } },
  allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
}

const origin: OriginRef = {
  plugin: 'http',
  projectId: 'proj-123',
  runId: 'run-456',
  resumeHandle: {},
}

test('buildPresentedEvent produces a host-sourced presented event', async () => {
  const event = await buildPresentedEvent({
    approvalId: 'apr-789',
    envelope,
    origin,
    actor: { kind: 'human', id: 'user-123', display: 'Admin User' },
    client: { channel: 'mobile', platform: 'ios', appVersion: '1.2.3' },
    seq: 2,
    prevEventId: 'evt-001',
    prevContentSha256: 'abcd1234',
  })

  assert.equal(event.event_type, 'presented')
  assert.equal(event.seq, 2)
  assert.equal(event.approval_id, 'apr-789')
  assert.ok(event.presented, 'presented block should exist')
  assert.equal(event.presented.source, 'host')
  assert.equal(event.presented.actor.kind, 'human')
  assert.equal(event.presented.actor.id, 'user-123')
  assert.equal(event.presented.actor.display, 'Admin User')
  assert.equal(event.presented.client?.channel, 'mobile')
  assert.equal(event.presented.client?.platform, 'ios')
  assert.equal(event.presented.client?.appVersion, '1.2.3')
  assert.match(event.presented.presented_at, /^\d{4}-\d{2}-\d{2}T/)
  // hitl-spec 5.2: presented has no `data` and no oversight.
  assert.equal((event as unknown as { data?: unknown }).data, undefined)
  assert.equal(event.oversight, undefined)
  // Chain fields come from the caller.
  assert.equal(event.integrity.alg, 'sha256')
  assert.equal(event.integrity.prev_event_id, 'evt-001')
  assert.equal(event.integrity.prev_content_sha256, 'abcd1234')
  assert.match(event.integrity.content_sha256, /^[a-f0-9]{64}$/)
})

test('buildPresentedEvent omits client when not provided and keeps the chain intact', async () => {
  const event = await buildPresentedEvent({
    approvalId: 'apr-789',
    envelope,
    origin,
    actor: { kind: 'human', id: 'user-123' },
    seq: 2,
  })
  assert.ok(event.presented)
  assert.equal(event.presented.client, undefined)
  assert.equal(event.presented.actor.display, undefined)
  // Hash is self-consistent for the built event.
  assert.equal(event.integrity.content_sha256, await hashEvidenceContent(event))
})

test('buildDecidedEvent adds decidedBy and client without touching reviewer_id', async () => {
  const payload: DecisionPayload = { decision: 'accept' }
  const event = await buildDecidedEvent({
    approvalId: 'apr-789',
    envelope,
    origin,
    payload,
    reviewerId: 'user-123',
    decidedBy: { kind: 'human', id: 'user-123', display: 'Admin User' },
    client: { channel: 'web', userAgent: 'Mozilla/5.0 (Macintosh)' },
    seq: 3,
    prevEventId: 'evt-002',
    prevContentSha256: 'abcd5678',
  })
  assert.ok(event.oversight)
  assert.equal(event.oversight.reviewer_id, 'user-123')
  assert.equal(event.oversight.decidedBy?.kind, 'human')
  assert.equal(event.oversight.decidedBy?.id, 'user-123')
  assert.equal(event.oversight.decidedBy?.display, 'Admin User')
  assert.equal(event.oversight.client?.channel, 'web')
  assert.equal(event.oversight.client?.userAgent, 'Mozilla/5.0 (Macintosh)')
  assert.equal(event.oversight.decision, 'accept')
})

test('buildDecidedEvent without decidedBy/client matches the pre-existing shape', async () => {
  const payload: DecisionPayload = { decision: 'accept' }
  const withFields = await buildDecidedEvent({
    approvalId: 'apr-789',
    envelope,
    origin,
    payload,
    reviewerId: 'user-123',
    seq: 3,
    prevEventId: 'evt-002',
    prevContentSha256: 'abcd5678',
  })
  assert.equal(withFields.oversight?.decidedBy, undefined)
  assert.equal(withFields.oversight?.client, undefined)
  assert.ok(withFields.oversight?.reviewer_id)
})
