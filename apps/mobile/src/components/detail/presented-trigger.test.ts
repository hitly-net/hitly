import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldRecordPresented } from './presented-trigger'

test('shouldRecordPresented: no POST when detail is missing or canAct is false (S97-S3)', () => {
  assert.equal(shouldRecordPresented(null, null), false)
  assert.equal(shouldRecordPresented(undefined, null), false)
  assert.equal(shouldRecordPresented({ id: 'apr_1', canAct: false }, null), false)
  assert.equal(shouldRecordPresented({ id: 'apr_1', canAct: false }, 'apr_other'), false)
})

test('shouldRecordPresented: fires once per id when canAct is true', () => {
  assert.equal(shouldRecordPresented({ id: 'apr_1', canAct: true }, null), true)
  assert.equal(shouldRecordPresented({ id: 'apr_1', canAct: true }, 'apr_other'), true)
  assert.equal(shouldRecordPresented({ id: 'apr_1', canAct: true }, 'apr_1'), false)
})
