import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SUPPORT_TICKET_TYPES, isSupportTicketType, type SupportTicketType } from './index.ts'

/**
 * Pins the Zammad `hitly_type` option set. The setup script derives the Zammad
 * Object Manager select options from this exact list, so value/label pairs are
 * a wire contract, not free text.
 */
const EXPECTED: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'billing', label: 'Billing' },
  { value: 'account', label: 'Account' },
  { value: 'data', label: 'Data' },
  { value: 'general', label: 'General' },
  { value: 'feature', label: 'Feature request' },
  { value: 'bug', label: 'Bug' },
  { value: 'security', label: 'Security/Abuse' },
]

test('SUPPORT_TICKET_TYPES carries the approved value/label pairs in order', () => {
  assert.deepEqual(SUPPORT_TICKET_TYPES.map(({ value, label }) => ({ value, label })), EXPECTED)
})

test('values and labels are unique', () => {
  const values = SUPPORT_TICKET_TYPES.map((t) => t.value)
  const labels = SUPPORT_TICKET_TYPES.map((t) => t.label)
  assert.equal(new Set(values).size, values.length)
  assert.equal(new Set(labels).size, labels.length)
})

test('isSupportTicketType accepts every listed value and rejects others', () => {
  for (const { value } of SUPPORT_TICKET_TYPES) {
    assert.equal(isSupportTicketType(value), true, `${value} should be valid`)
  }
  for (const bad of ['', 'Billing', 'refunds', 'security/abuse', 'FEATURE']) {
    assert.equal(isSupportTicketType(bad), false, `${bad} should be invalid`)
  }
})

test('derived type covers exactly the listed values', () => {
  const all: SupportTicketType[] = ['billing', 'account', 'data', 'general', 'feature', 'bug', 'security']
  for (const t of all) assert.equal(isSupportTicketType(t), true)
})
