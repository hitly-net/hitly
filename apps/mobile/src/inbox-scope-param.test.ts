import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FAILED_RESUME_INBOX_SCOPE, inboxScopeFromParam } from './inbox-scope-param'

test('the Failed resume card opens the inbox in the All scope', () => {
  // The rows it links to are failed_resume, which the open scope excludes.
  assert.equal(FAILED_RESUME_INBOX_SCOPE, 'all')
  assert.equal(inboxScopeFromParam(FAILED_RESUME_INBOX_SCOPE), 'all')
})

test('inboxScopeFromParam accepts every real scope', () => {
  for (const scope of ['open', 'all', 'closed'] as const) {
    assert.equal(inboxScopeFromParam(scope), scope)
  }
})

test('inboxScopeFromParam takes the first value of a repeated param', () => {
  assert.equal(inboxScopeFromParam(['all', 'open']), 'all')
})

test('inboxScopeFromParam rejects junk and missing params', () => {
  assert.equal(inboxScopeFromParam(undefined), undefined)
  assert.equal(inboxScopeFromParam(''), undefined)
  assert.equal(inboxScopeFromParam('decided'), undefined)
  assert.equal(inboxScopeFromParam('https://evil.example'), undefined)
  assert.equal(inboxScopeFromParam([]), undefined)
})
