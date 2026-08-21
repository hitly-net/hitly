/**
 * Tests for externalUrls in evidence events.
 * Verifies URLs are included in evidence and hashed correctly.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRequestedEvent, buildDecidedEvent, buildResumedEvent } from './evidence'
import { hashEvidenceContent } from '@hitly/core'
import type { ApprovalEnvelope, OriginRef, DecisionPayload } from '@hitly/core'

test('buildRequestedEvent includes externalUrls from envelope', async () => {
  const envelope: ApprovalEnvelope = {
    action: { name: 'test-action', args: { amount: 100 } },
    allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
    externalUrls: [
      { url: 'https://example.com/order/123', label: 'Order #123' },
      { url: 'https://example.com/ticket/456' },
    ],
  }

  const origin: OriginRef = {
    plugin: 'http',
    projectId: 'proj-123',
    runId: 'run-456',
    resumeHandle: {},
  }

  const event = await buildRequestedEvent({
    approvalId: 'apr-789',
    envelope,
    origin,
    seq: 1,
  })

  assert.ok(event.externalUrls)
  assert.equal(event.externalUrls.length, 2)
  assert.deepEqual(event.externalUrls[0], { url: 'https://example.com/order/123', label: 'Order #123' })
  assert.deepEqual(event.externalUrls[1], { url: 'https://example.com/ticket/456' })
})

test('buildRequestedEvent omits externalUrls when not in envelope', async () => {
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

  const event = await buildRequestedEvent({
    approvalId: 'apr-789',
    envelope,
    origin,
    seq: 1,
  })

  assert.equal(event.externalUrls, undefined)
})

test('buildDecidedEvent includes externalUrls from envelope', async () => {
  const envelope: ApprovalEnvelope = {
    action: { name: 'test-action', args: { amount: 100 } },
    allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
    externalUrls: [{ url: 'https://example.com/order/123', label: 'Order #123' }],
  }

  const origin: OriginRef = {
    plugin: 'http',
    projectId: 'proj-123',
    runId: 'run-456',
    resumeHandle: {},
  }

  const payload: DecisionPayload = {
    decision: 'accept',
  }

  const event = await buildDecidedEvent({
    approvalId: 'apr-789',
    envelope,
    origin,
    payload,
    reviewerId: 'user-123',
    seq: 2,
    prevEventId: 'evt-001',
    prevContentSha256: 'abcd1234',
  })

  assert.ok(event.externalUrls)
  assert.equal(event.externalUrls.length, 1)
  assert.deepEqual(event.externalUrls[0], { url: 'https://example.com/order/123', label: 'Order #123' })
})

test('buildResumedEvent includes externalUrls from envelope', async () => {
  const envelope: ApprovalEnvelope = {
    action: { name: 'test-action', args: { amount: 100 } },
    allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
    externalUrls: [{ url: 'https://example.com/order/123' }],
  }

  const origin: OriginRef = {
    plugin: 'http',
    projectId: 'proj-123',
    runId: 'run-456',
    resumeHandle: {},
  }

  const event = await buildResumedEvent({
    approvalId: 'apr-789',
    envelope,
    origin,
    seq: 3,
    prevEventId: 'evt-002',
    prevContentSha256: 'abcd5678',
    success: true,
  })

  assert.ok(event.externalUrls)
  assert.equal(event.externalUrls.length, 1)
  assert.deepEqual(event.externalUrls[0], { url: 'https://example.com/order/123' })
})

test('externalUrls are included in evidence hash via hashEvidenceContent', async () => {
  const envelope: ApprovalEnvelope = {
    action: { name: 'test-action', args: { amount: 100 } },
    allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
    externalUrls: [{ url: 'https://example.com/order/123', label: 'Order #123' }],
  }

  const origin: OriginRef = {
    plugin: 'http',
    projectId: 'proj-123',
    runId: 'run-456',
    resumeHandle: {},
  }

  const event1 = await buildRequestedEvent({
    approvalId: 'apr-789',
    envelope,
    origin,
    seq: 1,
  })

  const envelopeNoUrls: ApprovalEnvelope = {
    action: { name: 'test-action', args: { amount: 100 } },
    allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
  }

  const event2 = await buildRequestedEvent({
    approvalId: 'apr-789',
    envelope: envelopeNoUrls,
    origin,
    seq: 1,
  })

  // Events with different externalUrls should have different hashes
  assert.notEqual(event1.integrity.content_sha256, event2.integrity.content_sha256)

  // Verify the hash includes externalUrls by computing it manually
  const recomputedHash = await hashEvidenceContent(event1)
  assert.equal(event1.integrity.content_sha256, recomputedHash)
})

test('empty externalUrls array is handled correctly', async () => {
  const envelope: ApprovalEnvelope = {
    action: { name: 'test-action', args: { amount: 100 } },
    allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
    externalUrls: [],
  }

  const origin: OriginRef = {
    plugin: 'http',
    projectId: 'proj-123',
    runId: 'run-456',
    resumeHandle: {},
  }

  const event = await buildRequestedEvent({
    approvalId: 'apr-789',
    envelope,
    origin,
    seq: 1,
  })

  assert.deepEqual(event.externalUrls, [])
})
