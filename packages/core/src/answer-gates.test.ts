/**
 * Tests for answer gating (hitl-spec 3.6 reasonRequired, 3.7 mustOpen, 7 validation).
 * Pure logic — no database. Run with: yarn workspace @hitly/core test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contextItems,
  findContextItem,
  isBinaryLikeRequest,
  mustOpenItems,
  requiresReason,
  resolveReasonRequired,
  unopenedMustOpenItems,
  validateAnswerSubmission,
  validateRequestGating,
  type ApprovalEnvelope,
} from './index.ts'

const binaryAllowed = { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false }
const richAllowed = { accept: true, reject: true, edit: true, respond: true, ignore: false, cancel: false }

function envelope(overrides: Partial<ApprovalEnvelope> = {}): ApprovalEnvelope {
  return {
    action: { name: 'test-action', args: {} },
    allowedActions: binaryAllowed,
    ...overrides,
  } as ApprovalEnvelope
}

// --- reasonRequired (spec 3.6) ---

test('binary-shaped request defaults reasonRequired to [reject] when absent', () => {
  assert.ok(isBinaryLikeRequest(envelope()))
  assert.deepEqual(resolveReasonRequired(envelope()), ['reject'])
  assert.ok(requiresReason(envelope(), 'reject'))
  assert.ok(!requiresReason(envelope(), 'accept'))
})

test('non-binary request without reasonRequired has no required reasons', () => {
  const env = envelope({ allowedActions: richAllowed })
  assert.ok(!isBinaryLikeRequest(env))
  assert.deepEqual(resolveReasonRequired(env), [])
  assert.ok(!requiresReason(env, 'reject'))
})

test('declared reasonRequired wins over the binary default', () => {
  const env = envelope({ reasonRequired: ['accept'] })
  assert.deepEqual(resolveReasonRequired(env), ['accept'])
  assert.ok(requiresReason(env, 'accept'))
  assert.ok(!requiresReason(env, 'reject'))
})

test('resolveReasonRequired dedupes and drops blank entries', () => {
  const env = envelope({ allowedActions: richAllowed, reasonRequired: ['reject', 'reject', '  ', ''] })
  assert.deepEqual(resolveReasonRequired(env), ['reject'])
})

test('validateAnswerSubmission refuses a rejected binary answer without a reason', () => {
  const env = envelope()
  const without = validateAnswerSubmission({ envelope: env, decision: 'reject', openedRefs: [] })
  assert.equal(without.length, 1)
  assert.equal(without[0]!.field, 'reason')

  const withReason = validateAnswerSubmission({ envelope: env, decision: 'reject', reason: 'Amount too high', openedRefs: [] })
  assert.deepEqual(withReason, [])

  const blank = validateAnswerSubmission({ envelope: env, decision: 'reject', reason: '   ', openedRefs: [] })
  assert.equal(blank.length, 1, 'whitespace-only reason counts as missing')

  const accept = validateAnswerSubmission({ envelope: env, decision: 'accept', openedRefs: [] })
  assert.deepEqual(accept, [], 'accept is not reason-gated by default')
})

test('validateAnswerSubmission honours a declared reasonRequired list', () => {
  const env = envelope({ allowedActions: richAllowed, reasonRequired: ['edit', 'respond'] })
  assert.equal(validateAnswerSubmission({ envelope: env, decision: 'respond', openedRefs: [] }).length, 1)
  assert.deepEqual(validateAnswerSubmission({ envelope: env, decision: 'accept', openedRefs: [] }), [])
})

// --- mustOpen (spec 3.7) ---

test('contextItems derives refs from url/name and keeps declared refs', () => {
  const env = envelope({
    externalUrls: [{ url: 'https://example.com/order/123', label: 'Order #123' }],
    attachments: [{ name: 'invoice.pdf', url: 'https://files.example.com/invoice.pdf', contentType: 'application/pdf' }],
  })
  const items = contextItems(env)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    ref: 'https://example.com/order/123',
    kind: 'link',
    label: 'Order #123',
    url: 'https://example.com/order/123',
    mustOpen: false,
  })
  assert.equal(items[1]!.ref, 'invoice.pdf:https://files.example.com/invoice.pdf')
})

test('mustOpenItems only gates items with an openable url', () => {
  const env = envelope({
    externalUrls: [{ url: 'https://example.com/a', mustOpen: true }, { url: 'https://example.com/b' }],
    attachments: [{ name: 'notes.md', mustOpen: true }],
  })
  const gated = mustOpenItems(env)
  assert.deepEqual(gated.map((item) => item.ref), ['https://example.com/a'], 'attachment without url gates nothing')
})

test('mustOpen gating refuses answers that skip unopened items and passes after opens', () => {
  const env = envelope({
    externalUrls: [{ url: 'https://example.com/policy', ref: 'policy', mustOpen: true }],
  })
  const blocked = validateAnswerSubmission({ envelope: env, decision: 'accept', openedRefs: [] })
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0]!.field, 'context.items.policy')

  const blocked2 = validateAnswerSubmission({ envelope: env, decision: 'reject', reason: 'no', openedRefs: ['policy'] })
  assert.deepEqual(blocked2, [], 'opened refs unlock the answer')

  assert.deepEqual(unopenedMustOpenItems(env, ['policy']), [])
  assert.deepEqual(unopenedMustOpenItems(env, []), mustOpenItems(env))
})

test('findContextItem accepts refs and raw urls', () => {
  const env = envelope({ externalUrls: [{ url: 'https://example.com/x', ref: 'x-ref', mustOpen: true }] })
  assert.ok(findContextItem(env, 'x-ref'))
  assert.ok(findContextItem(env, 'https://example.com/x'))
  assert.equal(findContextItem(env, 'https://other.example.com/x'), undefined)
})

// --- ingest validation (spec 7, at request ingest) ---

test('validateRequestGating refuses reasonRequired values that are not allowed answers', () => {
  const ok = validateRequestGating(envelope({ reasonRequired: ['reject'] }))
  assert.deepEqual(ok, [])

  const bad = validateRequestGating(envelope({ reasonRequired: ['reject', 'banana', 'respond'] }))
  assert.equal(bad.length, 2, 'banana is not a decision and respond is not allowed')
  assert.ok(bad.every((error) => error.field === 'reasonRequired'))
})

test('validateRequestGating refuses duplicate context refs', () => {
  const dup = validateRequestGating(
    envelope({
      externalUrls: [
        { url: 'https://example.com/one', ref: 'shared' },
        { url: 'https://example.com/two', ref: 'shared', mustOpen: true },
      ],
    }),
  )
  assert.equal(dup.length, 1)
  assert.equal(dup[0]!.field, 'context.items.shared')
})

test('validateRequestGating refuses the same url declared twice without refs', () => {
  const dup = validateRequestGating(
    envelope({
      externalUrls: [{ url: 'https://example.com/twice' }, { url: 'https://example.com/twice', mustOpen: true }],
    }),
  )
  assert.equal(dup.length, 1, 'derived refs collide when one url is declared twice')
  assert.equal(dup[0]!.field, 'context.items.https://example.com/twice')
})

test('validateRequestGating accepts a fully specified request', () => {
  const env = envelope({
    allowedActions: richAllowed,
    reasonRequired: ['reject'],
    externalUrls: [{ url: 'https://example.com/one', ref: 'order', mustOpen: true }],
    attachments: [{ name: 'a.pdf', url: 'https://files.example.com/a.pdf', ref: 'invoice', mustOpen: true }],
  })
  assert.deepEqual(validateRequestGating(env), [])
})
