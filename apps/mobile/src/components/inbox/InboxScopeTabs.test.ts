import assert from 'node:assert/strict'
import { test } from 'node:test'

const INBOX_SCOPES = ['open', 'all', 'closed'] as const
type InboxScope = (typeof INBOX_SCOPES)[number]

function isInboxScope(value: string | undefined): value is InboxScope {
  return Boolean(value && (INBOX_SCOPES as readonly string[]).includes(value))
}

test('INBOX_SCOPES contains open, all, closed', () => {
  assert.deepEqual(INBOX_SCOPES, ['open', 'all', 'closed'])
})

test('isInboxScope: open is valid', () => {
  assert.equal(isInboxScope('open'), true)
})

test('isInboxScope: all is valid', () => {
  assert.equal(isInboxScope('all'), true)
})

test('isInboxScope: closed is valid', () => {
  assert.equal(isInboxScope('closed'), true)
})

test('isInboxScope: pending is not valid', () => {
  assert.equal(isInboxScope('pending'), false)
})

test('isInboxScope: undefined is not valid', () => {
  assert.equal(isInboxScope(undefined), false)
})

test('isInboxScope: empty string is not valid', () => {
  assert.equal(isInboxScope(''), false)
})
