import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decisionNeededTitle, pushCopy } from './push'

test('notification email subject starts with HITLy:', () => {
  const subject = decisionNeededTitle('ask_user')
  assert.ok(subject.startsWith('HITLy:'))
  assert.equal(subject, 'HITLy: ask_user needs a decision')
})

test('push title uses the HITLy brand prefix', () => {
  const copy = pushCopy({ actionName: 'ask_user' })
  assert.ok(copy.title.startsWith('HITLy:'))
  assert.equal(copy.title, 'HITLy: ask_user needs a decision')
})
