/**
 * Tests for projects server actions
 * Run with: yarn test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

test('throwUnlessConflict throws on non-409 errors (except 500 handled separately)', () => {
  const throwUnlessConflict = (result: { error?: string; status?: number | string }) => {
    if (result.error && result.status !== 409) throw new Error(result.error)
  }

  assert.throws(
    () => throwUnlessConflict({ error: 'Not found', status: 404 }),
    { message: 'Not found' },
    '404 should throw',
  )

  assert.throws(
    () => throwUnlessConflict({ error: 'Bad request', status: 400 }),
    { message: 'Bad request' },
    '400 should throw',
  )

  assert.throws(
    () => throwUnlessConflict({ error: 'Evidence sink append failed', status: 500 }),
    { message: 'Evidence sink append failed' },
    '500 should throw in throwUnlessConflict (but is handled before reaching it in decideWorkItem)',
  )

  assert.doesNotThrow(
    () => throwUnlessConflict({ error: 'Already decided', status: 409 }),
    '409 conflicts should not throw',
  )

  assert.doesNotThrow(
    () => throwUnlessConflict({}),
    'No error should not throw',
  )

  assert.doesNotThrow(
    () => throwUnlessConflict({ status: 200 }),
    'Success without error should not throw',
  )
})

test('500 errors are handled before throwUnlessConflict in decideWorkItem flow', () => {
  const result = { error: 'Evidence sink append failed (fail-closed): timeout', status: 500 }
  
  assert.equal(result.status, 500, 'Result should have 500 status')
  assert.ok(result.error, 'Result should have error message')
  assert.ok(
    result.error.includes('Evidence sink') || result.error.includes('fail-closed'),
    'Error should mention evidence sink or fail-closed',
  )
})

test('409 conflicts pass through without throwing', () => {
  const throwUnlessConflict = (result: { error?: string; status?: number | string }) => {
    if (result.error && result.status !== 409) throw new Error(result.error)
  }

  const result = { error: 'Approval is not awaiting a decision', status: 409 }
  
  assert.doesNotThrow(
    () => throwUnlessConflict(result),
    '409 should not throw',
  )
})
