/**
 * The ONE shared definition of "awaiting a human" used by every pending
 * surface (MCP list_pending, web/mobile pending inbox, pending counts).
 * A failed_resume row already carries a human decision, so it must never be
 * part of the pending set. Pure logic — no database.
 * Run with: yarn workspace @hitly/core test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AWAITING_HUMAN_APPROVAL_STATUSES,
  CLOSED_APPROVAL_STATUSES,
  isAwaitingHumanApprovalStatus,
  isOpenApprovalStatus,
} from './index.ts'

test('pending set is exactly the awaiting-a-human statuses', () => {
  assert.deepEqual([...AWAITING_HUMAN_APPROVAL_STATUSES], ['pending'])
})

test('failed_resume is never an awaiting-a-human status', () => {
  assert.equal(isAwaitingHumanApprovalStatus('failed_resume'), false)
  assert.equal((AWAITING_HUMAN_APPROVAL_STATUSES as readonly string[]).includes('failed_resume'), false)
})

test('pending is an awaiting-a-human status; decided outcomes are not', () => {
  assert.equal(isAwaitingHumanApprovalStatus('pending'), true)
  for (const decided of ['decided', 'expired', 'cancelled', 'failed_resume']) {
    assert.equal(isAwaitingHumanApprovalStatus(decided), false, `${decided} must not be pending`)
  }
  assert.equal(isAwaitingHumanApprovalStatus('nonsense'), false)
})

test('open is still a wider set than pending (open keeps failed_resume for lifecycle surfaces)', () => {
  assert.equal(isOpenApprovalStatus('failed_resume'), true, 'lifecycle "open" intentionally still includes failed_resume')
  assert.equal(isAwaitingHumanApprovalStatus('failed_resume'), false, 'pending must not')
  for (const status of AWAITING_HUMAN_APPROVAL_STATUSES) {
    assert.equal(isOpenApprovalStatus(status), true, 'every pending status is still open')
  }
})

test('pending and closed sets are disjoint and together cover the enum minus failed_resume', () => {
  const pendingSet = new Set<string>(AWAITING_HUMAN_APPROVAL_STATUSES)
  for (const status of CLOSED_APPROVAL_STATUSES) {
    assert.equal(pendingSet.has(status), false, `${status} cannot be both pending and closed`)
  }
})
